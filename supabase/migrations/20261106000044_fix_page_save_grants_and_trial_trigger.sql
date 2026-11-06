/*
# Fix page saving and set trial server-side from pricing settings

1. Permissions
- Owners can now write the `gtag_label` column (Google Ads conversion label) on both create and update. This column was added earlier without a grant, which made every page save fail.

2. Trial handling
- A new BEFORE INSERT trigger on `pages` sets `is_trial = true`, `is_active = true`, and `expires_at = now() + trial_days`.
- `trial_days` is read from the global row in `pricing_settings` (default 7 if missing).
- Owners cannot choose these values; the trigger always applies them to new pages.

3. Security
- The trigger function is SECURITY DEFINER with a fixed search_path and EXECUTE revoked from PUBLIC, anon and authenticated (triggers do not need EXECUTE for callers).
- No existing rows are changed.

# Notes
- Trigger-based trial setup means the client cannot grant itself a longer trial, because trial and expiry columns remain non-writable for owners.
- Admin-managed fields (expiry, trial flag, active state) are still changed only through the admin functions.
*/

GRANT INSERT (gtag_label), UPDATE (gtag_label) ON pages TO authenticated;

CREATE OR REPLACE FUNCTION public.apply_trial_on_page_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_days integer;
BEGIN
  SELECT trial_days INTO v_days FROM pricing_settings WHERE id = 'global';
  v_days := COALESCE(v_days, 7);

  NEW.is_trial := true;
  NEW.is_active := true;
  NEW.expires_at := now() + make_interval(days => v_days);
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.apply_trial_on_page_insert() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pages_apply_trial_on_insert ON pages;
CREATE TRIGGER pages_apply_trial_on_insert
BEFORE INSERT ON pages
FOR EACH ROW
EXECUTE FUNCTION public.apply_trial_on_page_insert();
