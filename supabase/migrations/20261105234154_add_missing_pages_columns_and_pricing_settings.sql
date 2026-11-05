/*
# Add missing page columns and create pricing settings table

Plain-English summary:
The app already reads and saves several page details (design theme, company name, Google Ads label, working hours, subscription expiry, trial flag) that the database did not have yet. This migration adds them. It also creates the table that stores the pricing page content and the three plan prices, which the admin panel edits and the pricing page displays.

1. Modified Table: pages (new columns, all additive)
- `theme` (text, default 'emerald'): colour theme chosen for the landing page.
- `company_name` (text, nullable): legacy business name used as a fallback for the title.
- `gtag_label` (text, default ''): Google Ads conversion label.
- `working_hours` (text, default ''): free-text working hours shown on the page.
- `expires_at` (timestamptz, nullable): date when the subscription ends. Empty means no expiry set.
- `is_trial` (boolean, not null, default false): marks trial pages.

2. New Table: pricing_settings
- One row with id 'global' holds the pricing page content.
- Columns: whatsapp_number, headline, subheadline, trial_days, and for each of the three plans: name, duration, old price, new price. Also updated_at.

3. Security
- RLS enabled on pricing_settings.
- Anyone (anon and signed-in users) can read pricing_settings, because the public pricing page shows it.
- Only signed-in admins (is_admin()) can insert or update pricing_settings.
- Owners may now also set `theme` and `working_hours` on their own page, through the existing owner-only policies. No new row-level rules are added to pages.

4. Important notes
- Every statement uses IF NOT EXISTS, so re-running this migration is safe.
- No existing data is changed or removed.
- The table name follows the app code (pricing_settings, plural).
*/

ALTER TABLE pages ADD COLUMN IF NOT EXISTS theme text NOT NULL DEFAULT 'emerald';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS gtag_label text NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS working_hours text NOT NULL DEFAULT '';
ALTER TABLE pages ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS is_trial boolean NOT NULL DEFAULT false;

GRANT INSERT (theme, working_hours), UPDATE (theme, working_hours) ON pages TO authenticated;

CREATE TABLE IF NOT EXISTS pricing_settings (
  id text PRIMARY KEY CHECK (id = 'global'),
  whatsapp_number text NOT NULL DEFAULT '',
  headline text NOT NULL DEFAULT '',
  subheadline text NOT NULL DEFAULT '',
  trial_days integer NOT NULL DEFAULT 7 CHECK (trial_days >= 0),
  plan1_name text NOT NULL DEFAULT '',
  plan1_duration text NOT NULL DEFAULT '',
  plan1_old_price text NOT NULL DEFAULT '',
  plan1_new_price text NOT NULL DEFAULT '',
  plan2_name text NOT NULL DEFAULT '',
  plan2_duration text NOT NULL DEFAULT '',
  plan2_old_price text NOT NULL DEFAULT '',
  plan2_new_price text NOT NULL DEFAULT '',
  plan3_name text NOT NULL DEFAULT '',
  plan3_duration text NOT NULL DEFAULT '',
  plan3_old_price text NOT NULL DEFAULT '',
  plan3_new_price text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE pricing_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pricing_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT ON pricing_settings TO anon, authenticated;
GRANT INSERT, UPDATE ON pricing_settings TO authenticated;

DROP POLICY IF EXISTS "public_select_pricing_settings" ON pricing_settings;
CREATE POLICY "public_select_pricing_settings" ON pricing_settings FOR SELECT
  TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "admin_insert_pricing_settings" ON pricing_settings;
CREATE POLICY "admin_insert_pricing_settings" ON pricing_settings FOR INSERT
  TO authenticated WITH CHECK ((select is_admin()));

DROP POLICY IF EXISTS "admin_update_pricing_settings" ON pricing_settings;
CREATE POLICY "admin_update_pricing_settings" ON pricing_settings FOR UPDATE
  TO authenticated USING ((select is_admin())) WITH CHECK ((select is_admin()));
