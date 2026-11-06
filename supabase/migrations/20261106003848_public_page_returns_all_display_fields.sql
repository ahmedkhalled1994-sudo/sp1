/*
# Public page returns all display fields

1. Modified Functions
- `get_public_page(p_slug)` now also returns `theme`, `company_name`, `gtag_label`,
  `working_hours`, `expires_at`, `is_trial`, so the live page shows the chosen colour theme,
  fires the owner's Google Ads conversion tag, shows working hours and handles expired/trial pages.
- `record_page_view` / `record_call_click` no longer count visits on expired pages.

2. Security
- Still SECURITY DEFINER with fixed search_path; only exposes public display fields of active pages
  (no user_id, email or counters). EXECUTE stays available to anon + authenticated (public page).

3. Notes
- The function must be dropped and recreated because its return columns change. No table data is touched.
*/

DROP FUNCTION IF EXISTS public.get_public_page(text);

CREATE FUNCTION public.get_public_page(p_slug text)
RETURNS TABLE(
  slug text, title text, company_name text, description text, phone text, icon text, theme text,
  hours_mode text, hours_from text, hours_to text, working_hours text,
  whatsapp text, instagram text, snapchat text, tiktok text,
  conversion_label text, gtag_label text,
  is_active boolean, is_trial boolean, expires_at timestamptz
)
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT p.slug, p.title, p.company_name, p.description, p.phone, p.icon, p.theme,
         p.hours_mode, p.hours_from, p.hours_to, p.working_hours,
         p.whatsapp, p.instagram, p.snapchat, p.tiktok,
         p.conversion_label, p.gtag_label,
         p.is_active, p.is_trial, p.expires_at
  FROM pages p
  WHERE p.slug = p_slug AND p.is_active;
$$;

REVOKE EXECUTE ON FUNCTION public.get_public_page(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_public_page(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.record_page_view(p_slug text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE pages SET views_count = views_count + 1
  WHERE slug = p_slug AND is_active AND (expires_at IS NULL OR expires_at > now());
$$;

CREATE OR REPLACE FUNCTION public.record_call_click(p_slug text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  UPDATE pages SET calls_count = calls_count + 1
  WHERE slug = p_slug AND is_active AND (expires_at IS NULL OR expires_at > now());
$$;