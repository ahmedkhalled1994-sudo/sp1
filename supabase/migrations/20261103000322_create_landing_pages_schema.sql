/*
# Create landing pages schema with secure access

Plain-English summary:
Each signed-in user can create and edit exactly one landing page. Visitors can open a page by its link, and only the safe public details are shown. Admins can see every page and turn pages on or off. Visit and call counters are updated only through controlled functions.

1. New Tables
- `pages`: one row per user (owner, slug, business details, social handles, Google Ads label, active flag, visit and call counters).
- `admin_users`: list of user IDs that have admin rights. Not readable or writable by app users.

2. Functions
- `is_admin()`: true when the signed-in user is listed in `admin_users`.
- `get_public_page(slug)`: returns only public fields of a page (never the owner's email).
- `record_page_view(slug)` and `record_call_click(slug)`: atomically add one to a counter for an active page.
- `admin_set_page_active(id, active)`: admin-only switch to enable or disable a page.

3. Security
- RLS enabled on both tables.
- Owners can read and change only their own page, and only the content columns. Owners cannot change ownership, email, active state, or counters.
- Admins can read all pages through a policy.
- Anonymous visitors have no direct table access; they use the functions above.

4. Important notes
- Each user has at most one page (unique owner) and each slug is unique across all users.
- The first admin must be added to `admin_users` manually.
*/

CREATE TABLE IF NOT EXISTS pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  user_email text NOT NULL DEFAULT (auth.jwt() ->> 'email'),
  slug text NOT NULL UNIQUE CHECK (char_length(slug) BETWEEN 3 AND 40),
  title text NOT NULL CHECK (char_length(title) BETWEEN 2 AND 120),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  phone text NOT NULL CHECK (phone ~ '^\+?[0-9]{6,20}$'),
  icon text NOT NULL DEFAULT '🎓' CHECK (char_length(icon) <= 8),
  hours_mode text NOT NULL DEFAULT '24/7' CHECK (hours_mode IN ('24/7', 'custom', 'appointment')),
  hours_from text NOT NULL DEFAULT '' CHECK (char_length(hours_from) <= 30),
  hours_to text NOT NULL DEFAULT '' CHECK (char_length(hours_to) <= 30),
  whatsapp text NOT NULL DEFAULT '' CHECK (whatsapp ~ '^\+?[0-9]{0,20}$'),
  instagram text NOT NULL DEFAULT '' CHECK (instagram ~ '^[A-Za-z0-9._]{0,30}$'),
  snapchat text NOT NULL DEFAULT '' CHECK (snapchat ~ '^[A-Za-z0-9._-]{0,30}$'),
  tiktok text NOT NULL DEFAULT '' CHECK (tiktok ~ '^[A-Za-z0-9._]{0,30}$'),
  conversion_label text NOT NULL DEFAULT '' CHECK (char_length(conversion_label) <= 100),
  is_active boolean NOT NULL DEFAULT true,
  views_count integer NOT NULL DEFAULT 0 CHECK (views_count >= 0),
  calls_count integer NOT NULL DEFAULT 0 CHECK (calls_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE
);

ALTER TABLE pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON admin_users FROM PUBLIC, anon, authenticated;

GRANT SELECT ON pages TO authenticated;
GRANT INSERT (slug, title, description, phone, icon, hours_mode, hours_from, hours_to,
  whatsapp, instagram, snapchat, tiktok, conversion_label) ON pages TO authenticated;
GRANT UPDATE (slug, title, description, phone, icon, hours_mode, hours_from, hours_to,
  whatsapp, instagram, snapchat, tiktok, conversion_label) ON pages TO authenticated;

CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM admin_users WHERE admin_users.user_id = auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION is_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION is_admin() TO authenticated;

DROP POLICY IF EXISTS "owner_select_page" ON pages;
CREATE POLICY "owner_select_page" ON pages FOR SELECT
  TO authenticated USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "admin_select_pages" ON pages;
CREATE POLICY "admin_select_pages" ON pages FOR SELECT
  TO authenticated USING (is_admin());

DROP POLICY IF EXISTS "owner_insert_page" ON pages;
CREATE POLICY "owner_insert_page" ON pages FOR INSERT
  TO authenticated WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "owner_update_page" ON pages;
CREATE POLICY "owner_update_page" ON pages FOR UPDATE
  TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION get_public_page(p_slug text)
RETURNS TABLE (
  slug text,
  title text,
  description text,
  phone text,
  icon text,
  hours_mode text,
  hours_from text,
  hours_to text,
  whatsapp text,
  instagram text,
  snapchat text,
  tiktok text,
  conversion_label text,
  is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.slug, p.title, p.description, p.phone, p.icon, p.hours_mode, p.hours_from,
    p.hours_to, p.whatsapp, p.instagram, p.snapchat, p.tiktok, p.conversion_label, p.is_active
  FROM pages p
  WHERE p.slug = p_slug;
$$;

CREATE OR REPLACE FUNCTION record_page_view(p_slug text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE pages SET views_count = views_count + 1
  WHERE slug = p_slug AND is_active;
$$;

CREATE OR REPLACE FUNCTION record_call_click(p_slug text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE pages SET calls_count = calls_count + 1
  WHERE slug = p_slug AND is_active;
$$;

CREATE OR REPLACE FUNCTION admin_set_page_active(p_id uuid, p_active boolean)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;
  UPDATE pages SET is_active = p_active WHERE id = p_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION get_public_page(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_page_view(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION record_call_click(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION admin_set_page_active(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_public_page(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_page_view(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION record_call_click(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION admin_set_page_active(uuid, boolean) TO authenticated;
