/*
# PAG ADS — Phase 1: Security Hardening, Search Path Lockdown & Concurrency-Safe Rate Limiting
# File: 20261106041500_phase1_security_hardening_and_audit_logs.sql
#
# Complete Technical Corrections:
# 1. Public Page Data Protection: get_public_page masks phone, whatsapp, description, services,
#    social links, and tracking tags on suspended/expired pages, preventing PII/content leakage
#    while returning is_active and expires_at so live.js displays the exact status notice.
# 2. Concurrency-Safe Rate Limiting: Introduces public.rate_limit_buckets using atomic
#    ON CONFLICT DO UPDATE counters (eliminating phantom read / concurrent bypass vulnerabilities).
#    Drops requests without inserting into page_events when limits are exceeded (storage protection).
# 3. Event Validation: Rejects NULL and unsupported events upfront before any processing.
# 4. Atomic Webhook Processing: Introduces public.processed_webhook_events with unique event_id
#    to prevent duplicate delivery replays independently from payment-level uniqueness.
# 5. Search Path Security: SET search_path = '' on all SECURITY DEFINER functions with full schema qualification.
# 6. Audit Log Safety: log_admin_action execution revoked from client roles (internal/service_role only).
#    Customer PII removed from audit details. Pagination bounded between 1 and 100.
# 7. Complete Dependency-Ordered Rollback: Fully documented restoration steps for all replaced functions.
*/

-- ============================================================================
-- 0. HARDEN public.is_admin() WITH SET search_path = ''
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.admin_users
    WHERE user_id = (SELECT auth.uid())
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin() TO anon, authenticated, service_role;

-- ============================================================================
-- 1. ATOMIC CONCURRENCY-SAFE RATE LIMITING BUCKETS
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rate_limit_buckets (
  bucket_key text PRIMARY KEY,
  request_count integer NOT NULL DEFAULT 1,
  last_seen timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS rate_limit_buckets_seen_idx ON public.rate_limit_buckets(last_seen DESC);

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.rate_limit_buckets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.rate_limit_buckets TO service_role;

-- ============================================================================
-- 2. ADMINISTRATIVE AUDIT LOGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.admin_audit_logs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  action_type text NOT NULL CHECK (char_length(action_type) BETWEEN 2 AND 64),
  target_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  target_resource_type text NOT NULL DEFAULT 'page' CHECK (char_length(target_resource_type) <= 32),
  target_resource_id text NOT NULL DEFAULT '' CHECK (char_length(target_resource_id) <= 128),
  action_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address text NOT NULL DEFAULT '' CHECK (char_length(ip_address) <= 64),
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS admin_audit_logs_actor_idx ON public.admin_audit_logs(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_action_idx ON public.admin_audit_logs(action_type, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_logs_created_idx ON public.admin_audit_logs(created_at DESC);

ALTER TABLE public.admin_audit_logs ENABLE ROW LEVEL SECURITY;

-- Protected against ordinary customer modification via RLS
REVOKE ALL ON public.admin_audit_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.admin_audit_logs TO authenticated;
GRANT ALL ON public.admin_audit_logs TO service_role;

DROP POLICY IF EXISTS "admin_select_audit_logs" ON public.admin_audit_logs;
CREATE POLICY "admin_select_audit_logs" ON public.admin_audit_logs
  FOR SELECT TO authenticated
  USING (public.is_admin());

-- ============================================================================
-- 3. WEBHOOK DELIVERY IDEMPOTENCY TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
  event_id text PRIMARY KEY,
  event_name text NOT NULL,
  provider text NOT NULL DEFAULT 'lemonsqueezy',
  processed_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

CREATE INDEX IF NOT EXISTS processed_webhook_created_idx ON public.processed_webhook_events(processed_at DESC);

ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.processed_webhook_events FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.processed_webhook_events TO service_role;

-- ============================================================================
-- 4. AUDIT LOGGING INTERNAL FUNCTION (search_path = '')
-- Restricted: Callable only by internal database functions and service_role
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_admin_action(
  p_action_type text,
  p_target_user_id uuid,
  p_target_resource_type text,
  p_target_resource_id text,
  p_details jsonb DEFAULT '{}'::jsonb
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_actor uuid := auth.uid();
  v_headers json;
  v_ip text := '';
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized: administrator privilege required';
  END IF;

  BEGIN
    v_headers := pg_catalog.current_setting('request.headers', true)::json;
    v_ip := pg_catalog.left(
      COALESCE(
        NULLIF(v_headers->>'cf-connecting-ip', ''),
        NULLIF(v_headers->>'x-real-ip', ''),
        NULLIF(pg_catalog.btrim(pg_catalog.split_part(COALESCE(v_headers->>'x-forwarded-for', ''), ',', 1)), ''),
        ''
      ), 64);
  EXCEPTION WHEN others THEN
    v_ip := '';
  END;

  INSERT INTO public.admin_audit_logs (
    actor_user_id,
    action_type,
    target_user_id,
    target_resource_type,
    target_resource_id,
    action_details,
    ip_address,
    created_at
  ) VALUES (
    v_actor,
    p_action_type,
    p_target_user_id,
    COALESCE(p_target_resource_type, 'page'),
    COALESCE(p_target_resource_id, ''),
    COALESCE(p_details, '{}'::jsonb),
    v_ip,
    pg_catalog.now()
  );
END;
$$;

-- Revoke from all client roles to prevent fabricated audit records
REVOKE ALL ON FUNCTION public.log_admin_action(text, uuid, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_admin_action(text, uuid, text, text, jsonb) TO service_role;

-- ============================================================================
-- 5. HARDENED ADMINISTRATIVE MUTATION FUNCTIONS (search_path = '')
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_set_page_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_slug text;
  v_prev_active boolean;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT user_id, slug, is_active INTO v_owner, v_slug, v_prev_active
  FROM public.pages WHERE id = p_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Page not found';
  END IF;

  UPDATE public.pages
  SET is_active = p_active
  WHERE id = p_id;

  PERFORM public.log_admin_action(
    CASE WHEN p_active THEN 'page_activate' ELSE 'page_suspend' END,
    v_owner,
    'page',
    p_id::text,
    pg_catalog.jsonb_build_object(
      'slug', v_slug,
      'previous_state', v_prev_active,
      'new_state', p_active
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_set_page_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_page_active(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_page_active(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_extend_subscription(p_id uuid, p_days integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_owner uuid;
  v_slug text;
  v_curr_exp timestamptz;
  v_new_exp timestamptz;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'Invalid number of days';
  END IF;

  SELECT user_id, slug, expires_at INTO v_owner, v_slug, v_curr_exp
  FROM public.pages WHERE id = p_id;

  IF v_owner IS NULL THEN
    RAISE EXCEPTION 'Page not found';
  END IF;

  v_new_exp := GREATEST(COALESCE(v_curr_exp, pg_catalog.now()), pg_catalog.now()) + pg_catalog.make_interval(days => p_days);

  UPDATE public.pages
  SET expires_at = v_new_exp,
      is_trial = false
  WHERE id = p_id;

  PERFORM public.log_admin_action(
    'subscription_extend',
    v_owner,
    'page',
    p_id::text,
    pg_catalog.jsonb_build_object(
      'slug', v_slug,
      'days_added', p_days,
      'previous_expires_at', v_curr_exp,
      'new_expires_at', v_new_exp
    )
  );

  RETURN v_new_exp;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_extend_subscription(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_extend_subscription(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_extend_subscription(uuid, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_ban_user(p_page_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
  v_slug text;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT user_id, slug INTO v_user_id, v_slug
  FROM public.pages WHERE id = p_page_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Page owner not found';
  END IF;

  -- Inserts into banned_users without customer email in audit payload
  INSERT INTO public.banned_users (user_id, banned_at)
  VALUES (v_user_id, pg_catalog.now())
  ON CONFLICT (user_id) DO UPDATE SET banned_at = pg_catalog.now();

  -- Suspends all published landing pages of this user
  UPDATE public.pages SET is_active = false WHERE user_id = v_user_id;

  PERFORM public.log_admin_action(
    'user_ban',
    v_user_id,
    'user',
    v_user_id::text,
    pg_catalog.jsonb_build_object(
      'triggering_page_id', p_page_id::text,
      'slug', v_slug,
      'action', 'pages_suspended_and_banned'
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_ban_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ban_user(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_ban_user(uuid) TO service_role;

-- ============================================================================
-- 6. CONCURRENCY-SAFE ATOMIC VISITOR RATE LIMITING & STORAGE PROTECTION
-- ============================================================================

CREATE OR REPLACE FUNCTION public.log_page_event(
  p_slug text,
  p_event text,
  p_visitor_id text,
  p_gclid text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_page_id uuid;
  v_headers json;
  v_ip text := '';
  v_ua text := '';
  v_visitor text;
  v_gclid text;
  v_window_10m bigint;
  v_window_1m bigint;
  v_bucket text;
  v_page_burst_bucket text;
  v_count int;
  v_burst_count int;
  v_recent_visitor int;
  v_reason text := '';
BEGIN
  -- 1. Explicit Parameter Validation
  IF p_event IS NULL OR p_event NOT IN ('view', 'call', 'whatsapp') THEN
    RETURN false;
  END IF;

  IF p_slug IS NULL OR pg_catalog.btrim(p_slug) = '' THEN
    RETURN false;
  END IF;

  v_visitor := pg_catalog.left(COALESCE(pg_catalog.btrim(p_visitor_id), ''), 64);
  v_gclid := pg_catalog.left(COALESCE(pg_catalog.btrim(p_gclid), ''), 200);

  -- 2. Lookup Target Page (must be active and non-expired)
  SELECT id INTO v_page_id FROM public.pages
  WHERE slug = p_slug AND is_active AND (expires_at IS NULL OR expires_at > pg_catalog.now());

  IF v_page_id IS NULL THEN
    RETURN false;
  END IF;

  -- 3. Extract Trusted Request Headers
  BEGIN
    v_headers := pg_catalog.current_setting('request.headers', true)::json;
    v_ip := pg_catalog.left(
      COALESCE(
        NULLIF(v_headers->>'cf-connecting-ip', ''),
        NULLIF(v_headers->>'x-real-ip', ''),
        NULLIF(pg_catalog.btrim(pg_catalog.split_part(COALESCE(v_headers->>'x-forwarded-for', ''), ',', 1)), ''),
        ''
      ), 64);
    v_ua := pg_catalog.left(COALESCE(v_headers->>'user-agent', ''), 300);
  EXCEPTION WHEN others THEN
    v_headers := NULL;
    v_ip := '';
    v_ua := '';
  END;

  -- 4. Concurrency-Safe Atomic Rate Limiting (ON CONFLICT DO UPDATE)
  v_window_10m := (EXTRACT(EPOCH FROM pg_catalog.now())::bigint / 600);
  v_window_1m := (EXTRACT(EPOCH FROM pg_catalog.now())::bigint / 60);

  -- A. Storage-Safe IP Rate Cap (40 events per 10 minutes per page)
  IF v_ip <> '' THEN
    v_bucket := 'page_ip:' || v_page_id::text || ':' || v_ip || ':' || v_window_10m::text;

    INSERT INTO public.rate_limit_buckets (bucket_key, request_count, last_seen)
    VALUES (v_bucket, 1, pg_catalog.now())
    ON CONFLICT (bucket_key) DO UPDATE
    SET request_count = public.rate_limit_buckets.request_count + 1,
        last_seen = pg_catalog.now()
    RETURNING request_count INTO v_count;

    -- Drop immediately without inserting into page_events (zero table bloat)
    IF v_count > 40 THEN
      RETURN false;
    END IF;
  ELSE
    -- Missing IP fallback: Burst protection per page (max 100 requests/minute)
    v_page_burst_bucket := 'page_burst:' || v_page_id::text || ':' || v_window_1m::text;

    INSERT INTO public.rate_limit_buckets (bucket_key, request_count, last_seen)
    VALUES (v_page_burst_bucket, 1, pg_catalog.now())
    ON CONFLICT (bucket_key) DO UPDATE
    SET request_count = public.rate_limit_buckets.request_count + 1,
        last_seen = pg_catalog.now()
    RETURNING request_count INTO v_burst_count;

    IF v_burst_count > 100 THEN
      RETURN false;
    END IF;
  END IF;

  -- 5. Suspicious Traffic Classification (Best-Effort Signals)
  IF v_ua = '' OR v_ua ~* '(bot|spider|crawl|scraper|headless|selenium|phantom|puppeteer|playwright|curl|wget|python|httpclient|postman)' THEN
    v_reason := 'برنامج آلي أو أداة مسح آلية';
  ELSIF v_visitor = '' AND v_ip = '' THEN
    v_reason := 'زيارة بدون هوية متصفح أو عنوان IP موثق';
  ELSIF p_event = 'view' THEN
    SELECT pg_catalog.count(*) INTO v_recent_visitor FROM public.page_events
    WHERE page_id = v_page_id AND event_type = 'view'
      AND (
        (v_visitor <> '' AND visitor_id = v_visitor) OR
        (v_ip <> '' AND ip = v_ip)
      )
      AND created_at > pg_catalog.now() - interval '24 hours';

    IF v_recent_visitor >= 5 THEN
      v_reason := 'زيارات متكررة لنفس الصفحة خلال 24 ساعة';
    END IF;
  ELSE
    -- Cooldown window for conversion actions (call / whatsapp): 30 minutes
    SELECT pg_catalog.count(*) INTO v_recent_visitor FROM public.page_events
    WHERE page_id = v_page_id AND event_type = p_event AND NOT is_suspicious
      AND (
        (v_visitor <> '' AND visitor_id = v_visitor) OR
        (v_ip <> '' AND ip = v_ip)
      )
      AND created_at > pg_catalog.now() - interval '30 minutes';

    IF v_recent_visitor >= 1 THEN
      v_reason := 'نقر متكرر من نفس المصدر خلال فترة التبريد';
    END IF;
  END IF;

  -- 6. Insert audit trail into page_events
  INSERT INTO public.page_events (
    page_id,
    event_type,
    visitor_id,
    ip,
    user_agent,
    gclid,
    from_ad,
    is_suspicious,
    suspicious_reason,
    created_at
  ) VALUES (
    v_page_id,
    p_event,
    v_visitor,
    v_ip,
    v_ua,
    v_gclid,
    v_gclid <> '',
    v_reason <> '',
    v_reason,
    pg_catalog.now()
  );

  IF v_reason <> '' THEN
    RETURN false;
  END IF;

  -- 7. Atomically increment legitimate counters
  IF p_event = 'view' THEN
    UPDATE public.pages SET views_count = views_count + 1 WHERE id = v_page_id;
  ELSIF p_event = 'call' THEN
    UPDATE public.pages SET calls_count = calls_count + 1 WHERE id = v_page_id;
  ELSE
    UPDATE public.pages SET whatsapp_clicks = whatsapp_clicks + 1 WHERE id = v_page_id;
  END IF;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.log_page_event(text, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.log_page_event(text, text, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_page_event(text, text, text, text) TO service_role;

-- ============================================================================
-- 7. PUBLIC PAGE COMPATIBILITY WITH DATA PROTECTION (search_path = '')
-- Masks phone, whatsapp, description, services, social links, and tags
-- when a page is suspended or expired, preventing marketing data leakage.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_public_page(p_slug text)
RETURNS TABLE(
  slug text,
  title text,
  company_name text,
  description text,
  phone text,
  icon text,
  theme text,
  hours_mode text,
  hours_from text,
  hours_to text,
  working_hours text,
  whatsapp text,
  instagram text,
  snapchat text,
  tiktok text,
  conversion_label text,
  gtag_label text,
  is_active boolean,
  is_trial boolean,
  expires_at timestamptz,
  services text,
  service_area text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    p.slug,
    p.title,
    p.company_name,
    -- If page is active and not expired: return full marketing details.
    -- If suspended or expired: mask marketing fields to protect customer privacy.
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.description ELSE '' END AS description,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.phone ELSE '' END AS phone,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.icon ELSE '🎓' END AS icon,
    p.theme,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.hours_mode ELSE '24/7' END AS hours_mode,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.hours_from ELSE '' END AS hours_from,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.hours_to ELSE '' END AS hours_to,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.working_hours ELSE '' END AS working_hours,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.whatsapp ELSE '' END AS whatsapp,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.instagram ELSE '' END AS instagram,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.snapchat ELSE '' END AS snapchat,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.tiktok ELSE '' END AS tiktok,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.conversion_label ELSE '' END AS conversion_label,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.gtag_label ELSE '' END AS gtag_label,
    p.is_active,
    p.is_trial,
    p.expires_at,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.services ELSE '' END AS services,
    CASE WHEN p.is_active AND (p.expires_at IS NULL OR p.expires_at > pg_catalog.now()) THEN p.service_area ELSE '' END AS service_area
  FROM public.pages p
  WHERE p.slug = pg_catalog.btrim(p_slug);
$$;

REVOKE ALL ON FUNCTION public.get_public_page(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_page(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_public_page(text) TO service_role;

-- ============================================================================
-- 8. AUDIT LOG RETRIEVAL FUNCTION (ADMIN ONLY, BOUNDED PAGINATION)
-- ============================================================================

CREATE OR REPLACE FUNCTION public.admin_get_audit_logs(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS TABLE (
  id bigint,
  actor_user_id uuid,
  actor_email text,
  action_type text,
  target_user_id uuid,
  target_resource_type text,
  target_resource_id text,
  action_details jsonb,
  ip_address text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_safe_limit int;
  v_safe_offset int;
BEGIN
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized: administrator privilege required';
  END IF;

  v_safe_limit := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
  v_safe_offset := GREATEST(COALESCE(p_offset, 0), 0);

  RETURN QUERY
  SELECT
    l.id,
    l.actor_user_id,
    COALESCE(u.email, 'النظام')::text AS actor_email,
    l.action_type,
    l.target_user_id,
    l.target_resource_type,
    l.target_resource_id,
    l.action_details,
    l.ip_address,
    l.created_at
  FROM public.admin_audit_logs l
  LEFT JOIN auth.users u ON u.id = l.actor_user_id
  ORDER BY l.created_at DESC
  LIMIT v_safe_limit OFFSET v_safe_offset;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_get_audit_logs(integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_get_audit_logs(integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_get_audit_logs(integer, integer) TO service_role;

-- ============================================================================
-- 9. COMPLETE DEPENDENCY-ORDERED ROLLBACK SCRIPT (SECURITY-PRESERVING)
-- ============================================================================
/*
SECURITY WARNING FOR OPERATIONAL ROLLBACK:
- Even if audit logging or rate-limit buckets are rolled back on Staging,
  NEVER revert SECURITY DEFINER functions to `SET search_path = public` and
  NEVER remove PII masking from `public.get_public_page`.
- All restored functions below preserve `SET search_path = ''` and full schema qualification.

-- STEP 1: Restore admin mutation functions without log_admin_action dependency (preserving SET search_path = ''):
CREATE OR REPLACE FUNCTION public.admin_set_page_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $rb$
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  UPDATE public.pages SET is_active = p_active WHERE id = p_id;
END;
$rb$;

CREATE OR REPLACE FUNCTION public.admin_extend_subscription(p_id uuid, p_days integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $rb$
DECLARE
  v_expires_at timestamptz;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN RAISE EXCEPTION 'Invalid number of days'; END IF;
  UPDATE public.pages SET
    expires_at = GREATEST(COALESCE(expires_at, pg_catalog.now()), pg_catalog.now()) + pg_catalog.make_interval(days => p_days),
    is_trial = false
  WHERE id = p_id
  RETURNING expires_at INTO v_expires_at;
  IF v_expires_at IS NULL THEN RAISE EXCEPTION 'Page not found'; END IF;
  RETURN v_expires_at;
END;
$rb$;

CREATE OR REPLACE FUNCTION public.admin_ban_user(p_page_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $rb$
DECLARE
  v_user_id uuid;
BEGIN
  IF NOT public.is_admin() THEN RAISE EXCEPTION 'Not authorized'; END IF;
  SELECT user_id INTO v_user_id FROM public.pages WHERE id = p_page_id;
  IF v_user_id IS NULL THEN RAISE EXCEPTION 'Page owner not found'; END IF;
  INSERT INTO public.banned_users (user_id, banned_at)
  VALUES (v_user_id, pg_catalog.now())
  ON CONFLICT (user_id) DO UPDATE SET banned_at = pg_catalog.now();
  UPDATE public.pages SET is_active = false WHERE user_id = v_user_id;
END;
$rb$;

-- STEP 2: Drop the audit helper functions:
DROP FUNCTION IF EXISTS public.admin_get_audit_logs(integer, integer);
DROP FUNCTION IF EXISTS public.log_admin_action(text, uuid, text, text, jsonb);

-- STEP 3: Restore grants on restored functions:
REVOKE ALL ON FUNCTION public.admin_set_page_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_set_page_active(uuid, boolean) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_extend_subscription(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_extend_subscription(uuid, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_ban_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_ban_user(uuid) TO authenticated, service_role;
*/

