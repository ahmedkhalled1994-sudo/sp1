/*
# Lemon Squeezy online payments

Plain-English summary:
Customers can now pay for a plan online through Lemon Squeezy. When Lemon Squeezy confirms a payment,
the customer's page is extended automatically by the plan's number of days and leaves trial mode.
The admin enters each plan's Lemon Squeezy product number (variant id) and duration in days from the
pricing admin screen, so payments can be configured or changed later without code changes.

1. Modified Table: pricing_settings
- `plan1_variant_id`, `plan2_variant_id`, `plan3_variant_id` (text, default ''): Lemon Squeezy variant id per plan. Empty = online payment off for that plan.
- `plan1_days` (int, default 30), `plan2_days` (default 90), `plan3_days` (default 365): days added to the page per payment.

2. New Table: payments
- `id` (uuid, pk), `event_key` (text, unique; Lemon Squeezy order/invoice id, prevents double-counting a payment),
  `user_id` (uuid, payer), `page_id` (uuid, extended page), `plan` (1-3), `days`, `amount` (smallest currency unit),
  `currency`, `created_at`.

3. New Function: record_lemon_payment
- Resolves the plan from the paid variant id (never from customer-supplied data), records the payment once, and extends the page.
- SECURITY DEFINER; EXECUTE only for service_role (called only by the verified payment webhook).

4. Security
- RLS on payments: owners can read their own payments; no one can write directly.
- Grants: SELECT on payments to authenticated; ALL to service_role.

5. Notes
- Re-running is safe (IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS).
- No existing data is changed.
*/

ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS plan1_variant_id text NOT NULL DEFAULT '';
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS plan2_variant_id text NOT NULL DEFAULT '';
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS plan3_variant_id text NOT NULL DEFAULT '';
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS plan1_days integer NOT NULL DEFAULT 30 CHECK (plan1_days BETWEEN 1 AND 366);
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS plan2_days integer NOT NULL DEFAULT 90 CHECK (plan2_days BETWEEN 1 AND 366);
ALTER TABLE pricing_settings ADD COLUMN IF NOT EXISTS plan3_days integer NOT NULL DEFAULT 365 CHECK (plan3_days BETWEEN 1 AND 366);

CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  page_id uuid REFERENCES pages(id) ON DELETE SET NULL,
  plan smallint NOT NULL CHECK (plan BETWEEN 1 AND 3),
  days integer NOT NULL,
  amount integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_user_id_idx ON payments(user_id);
CREATE INDEX IF NOT EXISTS payments_page_id_idx ON payments(page_id);

ALTER TABLE payments ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON payments FROM PUBLIC, anon, authenticated;
GRANT SELECT ON payments TO authenticated;
GRANT ALL ON payments TO service_role;

DROP POLICY IF EXISTS "select_own_payments" ON payments;
CREATE POLICY "select_own_payments" ON payments FOR SELECT
  TO authenticated USING ((select auth.uid()) = user_id);

CREATE OR REPLACE FUNCTION record_lemon_payment(
  p_event_key text,
  p_user_id uuid,
  p_variant_id text,
  p_amount integer,
  p_currency text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s pricing_settings%ROWTYPE;
  v_plan smallint;
  v_days integer;
  v_page_id uuid;
  v_inserted uuid;
BEGIN
  SELECT * INTO s FROM pricing_settings WHERE id = 'global';
  IF NOT FOUND OR coalesce(p_variant_id, '') = '' THEN
    RETURN 'unknown_plan';
  END IF;

  IF p_variant_id = s.plan1_variant_id THEN v_plan := 1; v_days := s.plan1_days;
  ELSIF p_variant_id = s.plan2_variant_id THEN v_plan := 2; v_days := s.plan2_days;
  ELSIF p_variant_id = s.plan3_variant_id THEN v_plan := 3; v_days := s.plan3_days;
  ELSE
    RETURN 'unknown_plan';
  END IF;

  SELECT id INTO v_page_id FROM pages WHERE user_id = p_user_id;
  IF v_page_id IS NULL THEN
    RETURN 'no_page';
  END IF;

  INSERT INTO payments (event_key, user_id, page_id, plan, days, amount, currency)
  VALUES (p_event_key, p_user_id, v_page_id, v_plan, v_days, coalesce(p_amount, 0), coalesce(p_currency, ''))
  ON CONFLICT (event_key) DO NOTHING
  RETURNING id INTO v_inserted;

  IF v_inserted IS NULL THEN
    RETURN 'duplicate';
  END IF;

  UPDATE pages SET
    expires_at = GREATEST(COALESCE(expires_at, now()), now()) + make_interval(days => v_days),
    is_trial = false
  WHERE id = v_page_id;

  RETURN 'ok';
END;
$$;

REVOKE EXECUTE ON FUNCTION record_lemon_payment(text, uuid, text, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_lemon_payment(text, uuid, text, integer, text) TO service_role;