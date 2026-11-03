/*
# Optimize pages row policies

Plain-English summary:
Rewrites the access rules on the pages table so the signed-in user check is evaluated once per query instead of once per row, and merges the owner and admin read rules into one rule. Access rights stay the same: owners see their own page, admins see all pages.

1. Modified Policies
- `owner_select_page` now also covers admins (replaces the separate `admin_select_pages` policy).
- `owner_insert_page` and `owner_update_page` use the cached user check.

2. Security
- No new privileges are granted. Access is the same as before.
*/

DROP POLICY IF EXISTS "admin_select_pages" ON pages;
DROP POLICY IF EXISTS "owner_select_page" ON pages;
CREATE POLICY "owner_or_admin_select_page" ON pages FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id OR (select is_admin()));

DROP POLICY IF EXISTS "owner_insert_page" ON pages;
CREATE POLICY "owner_insert_page" ON pages FOR INSERT
  TO authenticated WITH CHECK ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "owner_update_page" ON pages;
CREATE POLICY "owner_update_page" ON pages FOR UPDATE
  TO authenticated USING ((select auth.uid()) = user_id) WITH CHECK ((select auth.uid()) = user_id);
