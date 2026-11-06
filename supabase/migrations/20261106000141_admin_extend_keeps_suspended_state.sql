/*
# Admin subscription extension no longer reactivates suspended pages

1. Changed function
- `admin_extend_subscription(p_id, p_days)` still adds days to the later of the current expiry or today, and still clears the trial flag.
- It no longer sets `is_active = true`. A suspended page stays suspended after an extension, so an admin's deliberate suspension is not undone by a renewal.

2. Security
- Still SECURITY DEFINER with a fixed search_path, an admin-only check through `is_admin()`, and EXECUTE granted only to authenticated.

# Notes
- To reactivate a suspended page, the admin uses the page edit form (active state), which calls the admin update function.
*/

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
    is_trial = false
  WHERE id = p_id
  RETURNING expires_at INTO v_expires_at;

  IF v_expires_at IS NULL THEN
    RAISE EXCEPTION 'Page not found';
  END IF;

  RETURN v_expires_at;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_extend_subscription(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_extend_subscription(uuid, integer) TO authenticated;
