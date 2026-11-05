/*
# Admin functions for managing page details and subscriptions

Plain-English summary:
Admins could not save changes to pages they do not own, because the table rules only let each owner change their own page. Changes from the admin screen were therefore silently ignored. This migration adds two admin-only actions the admin screen can call: one saves a page's details (including the trial flag and expiry date), and one extends a subscription by a number of days. Owners still cannot change their own subscription, trial flag, active state, or expiry date.

1. New Functions
- `admin_update_page(...)`: saves a page's details, active state, trial flag and expiry date. Fails if the page does not exist.
- `admin_extend_subscription(p_id, p_days)`: adds days to the later of the current expiry date or today, turns the page on, and clears the trial flag. Returns the new expiry date.

2. Security
- Both functions first check the caller is an admin (is_admin()) and raise an error otherwise.
- Both run with the owner's rights and a fixed search path, so callers cannot redirect them.
- Execute permission is removed from anonymous visitors and public access; only signed-in users can call them, and the admin check decides who gets through.
- No table privileges or row rules change. Owners keep their existing limited access.

3. Important notes
- The page link (slug) is not changed by these functions; it stays locked after creation.
- Extension length is limited to 1 to 366 days.
- Every statement is safe to re-run.
*/

CREATE OR REPLACE FUNCTION admin_update_page(
  p_id uuid,
  p_title text,
  p_phone text,
  p_description text,
  p_theme text,
  p_working_hours text,
  p_gtag_label text,
  p_whatsapp text,
  p_instagram text,
  p_snapchat text,
  p_tiktok text,
  p_is_active boolean,
  p_is_trial boolean,
  p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  UPDATE pages SET
    title = p_title,
    company_name = p_title,
    phone = p_phone,
    description = p_description,
    theme = p_theme,
    working_hours = p_working_hours,
    gtag_label = p_gtag_label,
    whatsapp = p_whatsapp,
    instagram = p_instagram,
    snapchat = p_snapchat,
    tiktok = p_tiktok,
    is_active = p_is_active,
    is_trial = p_is_trial,
    expires_at = p_expires_at
  WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Page not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_extend_subscription(p_id uuid, p_days integer)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_expires_at timestamptz;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_days IS NULL OR p_days < 1 OR p_days > 366 THEN
    RAISE EXCEPTION 'Invalid number of days';
  END IF;

  UPDATE pages SET
    expires_at = GREATEST(COALESCE(expires_at, now()), now()) + make_interval(days => p_days),
    is_active = true,
    is_trial = false
  WHERE id = p_id
  RETURNING expires_at INTO v_expires_at;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION 'Page not found';
  END IF;

  RETURN v_expires_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_update_page(uuid, text, text, text, text, text, text, text, text, text, text, boolean, boolean, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_update_page(uuid, text, text, text, text, text, text, text, text, text, text, boolean, boolean, timestamptz) TO authenticated;

REVOKE EXECUTE ON FUNCTION admin_extend_subscription(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_extend_subscription(uuid, integer) TO authenticated;
