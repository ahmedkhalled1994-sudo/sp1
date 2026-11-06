/*
# Page content fields + visit log with suspicious-traffic detection

1. Modified Tables
- `pages`
  - `services` (text, default '') - list of services, one per line (max 1000 chars)
  - `service_area` (text, default '') - cities / areas served (max 150 chars)
  - `whatsapp_clicks` (integer, default 0) - counted WhatsApp button clicks
  - Owners may insert/update `services` and `service_area` only (column grants).

2. New Tables
- `page_events` - one row per visit / call click / WhatsApp click on a public page
  - `id` (bigint identity, pk)
  - `page_id` (uuid, fk pages, cascade delete)
  - `event_type` ('view' | 'call' | 'whatsapp')
  - `visitor_id` (random id kept in the visitor's browser)
  - `ip` (visitor IP as reported by the gateway headers)
  - `user_agent`, `gclid` (Google Ads click id, when the visit came from an ad)
  - `from_ad` (boolean), `is_suspicious` (boolean), `suspicious_reason` (text)
  - `created_at`

3. New Functions
- `log_page_event(p_slug, p_event, p_visitor_id, p_gclid)` SECURITY DEFINER, callable by anon/authenticated.
  Validates input, flags repeats from the same device/IP and known bots, ignores floods
  (more than 40 events per IP per page in 10 minutes are not stored), and only increments
  the page counters for non-suspicious events. Returns true when the event was counted.
- `get_public_page` now also returns `services` and `service_area`.

4. Removed Functions
- `record_page_view` and `record_call_click` are dropped: they let anyone inflate counters
  without any checks. Replaced by `log_page_event`. No table data is affected.

5. Security
- RLS enabled on `page_events`. Only SELECT is granted to `authenticated`; the owner of the page
  can read its events. No client role can insert/update/delete directly - writes only go
  through `log_page_event`.
*/

ALTER TABLE pages ADD COLUMN IF NOT EXISTS services text NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS service_area text NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS whatsapp_clicks integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_services_length') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_services_length CHECK (char_length(services) <= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_service_area_length') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_service_area_length CHECK (char_length(service_area) <= 150);
  END IF;
END $$;

GRANT INSERT (services, service_area), UPDATE (services, service_area) ON pages TO authenticated;
GRANT SELECT (services, service_area, whatsapp_clicks) ON pages TO authenticated;

CREATE TABLE IF NOT EXISTS page_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  event_type text NOT NULL CHECK (event_type IN ('view', 'call', 'whatsapp')),
  visitor_id text NOT NULL DEFAULT '',
  ip text NOT NULL DEFAULT '',
  user_agent text NOT NULL DEFAULT '',
  gclid text NOT NULL DEFAULT '',
  from_ad boolean NOT NULL DEFAULT false,
  is_suspicious boolean NOT NULL DEFAULT false,
  suspicious_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_events_page_created_idx ON page_events (page_id, created_at DESC);
CREATE INDEX IF NOT EXISTS page_events_page_ip_idx ON page_events (page_id, ip, created_at DESC);
CREATE INDEX IF NOT EXISTS page_events_page_visitor_idx ON page_events (page_id, visitor_id, created_at DESC);

ALTER TABLE page_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON page_events TO authenticated;

DROP POLICY IF EXISTS "owner_select_page_events" ON page_events;
CREATE POLICY "owner_select_page_events" ON page_events FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM pages p
    WHERE p.id = page_events.page_id AND p.user_id = (SELECT auth.uid())
  )
);

CREATE OR REPLACE FUNCTION public.log_page_event(
  p_slug text,
  p_event text,
  p_visitor_id text,
  p_gclid text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_page_id uuid;
  v_headers json;
  v_ip text;
  v_ua text;
  v_visitor text := left(coalesce(trim(p_visitor_id), ''), 64);
  v_gclid text := left(coalesce(trim(p_gclid), ''), 200);
  v_recent int;
  v_reason text := '';
BEGIN
  IF p_event NOT IN ('view', 'call', 'whatsapp') THEN
    RETURN false;
  END IF;

  SELECT id INTO v_page_id FROM pages
  WHERE slug = p_slug AND is_active AND (expires_at IS NULL OR expires_at > now());

  IF v_page_id IS NULL THEN
    RETURN false;
  END IF;

  BEGIN
    v_headers := current_setting('request.headers', true)::json;
  EXCEPTION WHEN others THEN
    v_headers := NULL;
  END;

  v_ip := left(coalesce(
    nullif(v_headers->>'cf-connecting-ip', ''),
    nullif(v_headers->>'x-real-ip', ''),
    nullif(trim(split_part(coalesce(v_headers->>'x-forwarded-for', ''), ',', 1)), ''),
    ''
  ), 64);
  v_ua := left(coalesce(v_headers->>'user-agent', ''), 300);

  IF v_ip <> '' THEN
    SELECT count(*) INTO v_recent FROM page_events
    WHERE page_id = v_page_id AND ip = v_ip AND created_at > now() - interval '10 minutes';
    IF v_recent >= 40 THEN
      RETURN false;
    END IF;
  END IF;

  IF v_ua = '' OR v_ua ~* '(bot|spider|crawl|scraper|headless|selenium|phantom|puppeteer|playwright|curl|wget|python|httpclient)' THEN
    v_reason := 'برنامج آلي وليس زائرًا حقيقيًا';
  ELSIF v_visitor = '' THEN
    v_reason := 'زيارة بدون هوية متصفح';
  ELSIF p_event = 'view' THEN
    SELECT count(*) INTO v_recent FROM page_events
    WHERE page_id = v_page_id AND event_type = 'view'
      AND (visitor_id = v_visitor OR (v_ip <> '' AND ip = v_ip))
      AND created_at > now() - interval '24 hours';
    IF v_recent >= 3 THEN
      v_reason := 'زيارات متكررة من نفس الجهاز خلال 24 ساعة';
    END IF;
  ELSE
    SELECT count(*) INTO v_recent FROM page_events
    WHERE page_id = v_page_id AND event_type = p_event AND NOT is_suspicious
      AND (visitor_id = v_visitor OR (v_ip <> '' AND ip = v_ip))
      AND created_at > now() - interval '1 hour';
    IF v_recent >= 1 THEN
      v_reason := 'ضغطات متكررة من نفس الجهاز خلال ساعة';
    END IF;
  END IF;

  INSERT INTO page_events (page_id, event_type, visitor_id, ip, user_agent, gclid, from_ad, is_suspicious, suspicious_reason)
  VALUES (v_page_id, p_event, v_visitor, v_ip, v_ua, v_gclid, v_gclid <> '', v_reason <> '', v_reason);

  IF v_reason <> '' THEN
    RETURN false;
  END IF;

  IF p_event = 'view' THEN
    UPDATE pages SET views_count = views_count + 1 WHERE id = v_page_id;
  ELSIF p_event = 'call' THEN
    UPDATE pages SET calls_count = calls_count + 1 WHERE id = v_page_id;
  ELSE
    UPDATE pages SET whatsapp_clicks = whatsapp_clicks + 1 WHERE id = v_page_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.log_page_event(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_page_event(text, text, text, text) TO anon, authenticated;

DROP FUNCTION IF EXISTS public.record_page_view(text);
DROP FUNCTION IF EXISTS public.record_call_click(text);

DROP FUNCTION IF EXISTS public.get_public_page(text);

CREATE FUNCTION public.get_public_page(p_slug text)
RETURNS TABLE(
  slug text, title text, company_name text, description text, phone text, icon text, theme text,
  hours_mode text, hours_from text, hours_to text, working_hours text,
  whatsapp text, instagram text, snapchat text, tiktok text,
  conversion_label text, gtag_label text,
  is_active boolean, is_trial boolean, expires_at timestamptz,
  services text, service_area text
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.slug, p.title, p.company_name, p.description, p.phone, p.icon, p.theme,
         p.hours_mode, p.hours_from, p.hours_to, p.working_hours,
         p.whatsapp, p.instagram, p.snapchat, p.tiktok,
         p.conversion_label, p.gtag_label,
         p.is_active, p.is_trial, p.expires_at,
         p.services, p.service_area
  FROM pages p
  WHERE p.slug = p_slug AND p.is_active;
$$;

REVOKE EXECUTE ON FUNCTION public.get_public_page(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_page(text) TO anon, authenticated;
