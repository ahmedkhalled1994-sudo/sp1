/*
# Admin page deletion and account bans

1. New table `banned_users`
- Stores banned account ids with their email and ban time.
- RLS enabled. Only admins can read it (SELECT policy using is_admin()). No insert, update or delete grants or policies: changes only happen through the admin functions below.

2. Enforcement
- `is_user_banned()` (SECURITY DEFINER) tells whether the current user is banned.
- Owners who are banned cannot create or update pages (insert and update policies now also require not banned).
- `get_public_page` returns nothing for suspended pages, so suspended or banned pages do not expose phone numbers and links to visitors.

3. Admin functions (all check is_admin())
- `admin_delete_page(p_id)`: permanently deletes a page.
- `admin_ban_user(p_page_id)`: bans the owner of that page and suspends all of their pages.
- `admin_unban_user(p_user_id)`: lifts a ban. Pages stay suspended until an admin reactivates them.

# Notes
- Ban does not delete the owner's account or pages; it blocks changes and hides the pages from visitors.
- Deleting a page is irreversible.
*/

CREATE TABLE IF NOT EXISTS banned_users (
  user_id uuid PRIMARY KEY,
  user_email text NOT NULL DEFAULT '',
  banned_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE banned_users ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON banned_users TO authenticated;

CREATE POLICY admin_select_banned_users ON banned_users
  FOR SELECT
  TO authenticated
  USING (is_admin());

CREATE OR REPLACE FUNCTION is_user_banned()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM banned_users WHERE user_id = auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION is_user_banned() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_user_banned() TO authenticated;

DROP POLICY IF EXISTS owner_insert_page ON pages;
CREATE POLICY owner_insert_page ON pages
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT auth.uid()) = user_id AND NOT (SELECT is_user_banned()));

DROP POLICY IF EXISTS owner_update_page ON pages;
CREATE POLICY owner_update_page ON pages
  FOR UPDATE
  TO authenticated
  USING ((SELECT auth.uid()) = user_id AND NOT (SELECT is_user_banned()))
  WITH CHECK ((SELECT auth.uid()) = user_id AND NOT (SELECT is_user_banned()));

CREATE OR REPLACE FUNCTION get_public_page(p_slug text)
RETURNS TABLE (
  slug text, title text, description text, phone text, icon text,
  hours_mode text, hours_from text, hours_to text, whatsapp text,
  instagram text, snapchat text, tiktok text, conversion_label text, is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.slug, p.title, p.description, p.phone, p.icon, p.hours_mode, p.hours_from,
    p.hours_to, p.whatsapp, p.instagram, p.snapchat, p.tiktok, p.conversion_label, p.is_active
  FROM pages p
  WHERE p.slug = p_slug AND p.is_active;
$$;

CREATE OR REPLACE FUNCTION admin_delete_page(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  DELETE FROM pages WHERE id = p_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Page not found';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION admin_ban_user(p_page_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_email text;
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  SELECT user_id, user_email INTO v_user_id, v_email FROM pages WHERE id = p_page_id;

  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Page owner not found';
  END IF;

  INSERT INTO banned_users (user_id, user_email, banned_at)
  VALUES (v_user_id, COALESCE(v_email, ''), now())
  ON CONFLICT (user_id) DO UPDATE SET banned_at = now();

  UPDATE pages SET is_active = false WHERE user_id = v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION admin_unban_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  DELETE FROM banned_users WHERE user_id = p_user_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION admin_delete_page(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_delete_page(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION admin_ban_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_ban_user(uuid) TO authenticated;

REVOKE EXECUTE ON FUNCTION admin_unban_user(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION admin_unban_user(uuid) TO authenticated;
