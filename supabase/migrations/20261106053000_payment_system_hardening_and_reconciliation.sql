-- ============================================================================
-- PAG ADS — PHASE 1 PAYMENT SYSTEM HARDENING, RECONCILIATION & ATOMIC WEBHOOKS
-- Migration: 20261106053000_payment_system_hardening_and_reconciliation.sql
-- ============================================================================
-- Rules enforced:
-- 1. Preserves existing tables, customer pages, pricing settings, and contracts.
-- 2. Enforces strict Test Mode vs Live Mode separation and intra-mode uniqueness
--    on pricing_settings.
-- 3. Adds processed_webhook_events and payment_reconciliation_issues with RLS.
-- 4. Enforces positive minor-unit integer amounts and cross-event uniqueness on
--    public.payments so a single purchase/invoice can never extend a page twice.
-- 5. Provides atomic transaction-safe webhook processing functions with advisory
--    locks on delivery_id, event_key, and (store_id, resource_type, resource_id).
-- 6. Protects refunds: never marks a payment as 'refunded' unless a positive
--    verified refunded_amount >= amount is proven; distinguishes full, partial,
--    and unverified refunds.
-- 7. Logs every admin reconciliation resolution into public.admin_audit_logs
--    using the exact 5-parameter public.log_admin_action signature.
-- 8. Provides safe operational cleanup for rate_limit_buckets while permanently
--    retaining payments, processed_webhook_events, payment_reconciliation_issues,
--    and admin_audit_logs.
-- ============================================================================

-- 1. Extend public.pricing_settings with provider mode and Test/Live separation
ALTER TABLE public.pricing_settings
  ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'lemonsqueezy',
  ADD COLUMN IF NOT EXISTS payment_provider_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS payment_mode text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS payment_provider_mode text NOT NULL DEFAULT 'disabled',
  ADD COLUMN IF NOT EXISTS store_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lemon_store_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lemon_test_store_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS plan1_test_variant_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS plan2_test_variant_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS plan3_test_variant_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS webhook_status text NOT NULL DEFAULT 'pending_secret',
  ADD COLUMN IF NOT EXISTS last_config_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_config_check_status text NOT NULL DEFAULT 'awaiting_credentials',
  ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'pricing_settings_payment_mode_chk'
      AND conrelid = 'public.pricing_settings'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.pricing_settings
      ADD CONSTRAINT pricing_settings_payment_mode_chk
      CHECK (payment_mode IN ('disabled', 'test', 'live'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'pricing_settings_payment_provider_mode_chk'
      AND conrelid = 'public.pricing_settings'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.pricing_settings
      ADD CONSTRAINT pricing_settings_payment_provider_mode_chk
      CHECK (payment_provider_mode IN ('disabled', 'test', 'live'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'pricing_settings_test_live_variant_separation_chk'
      AND conrelid = 'public.pricing_settings'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.pricing_settings
      ADD CONSTRAINT pricing_settings_test_live_variant_separation_chk
      CHECK (
        (pg_catalog.btrim(plan1_test_variant_id) = '' OR (
          pg_catalog.btrim(plan1_test_variant_id) <> pg_catalog.btrim(plan1_variant_id) AND
          pg_catalog.btrim(plan1_test_variant_id) <> pg_catalog.btrim(plan2_variant_id) AND
          pg_catalog.btrim(plan1_test_variant_id) <> pg_catalog.btrim(plan3_variant_id)
        ))
        AND
        (pg_catalog.btrim(plan2_test_variant_id) = '' OR (
          pg_catalog.btrim(plan2_test_variant_id) <> pg_catalog.btrim(plan1_variant_id) AND
          pg_catalog.btrim(plan2_test_variant_id) <> pg_catalog.btrim(plan2_variant_id) AND
          pg_catalog.btrim(plan2_test_variant_id) <> pg_catalog.btrim(plan3_variant_id)
        ))
        AND
        (pg_catalog.btrim(plan3_test_variant_id) = '' OR (
          pg_catalog.btrim(plan3_test_variant_id) <> pg_catalog.btrim(plan1_variant_id) AND
          pg_catalog.btrim(plan3_test_variant_id) <> pg_catalog.btrim(plan2_variant_id) AND
          pg_catalog.btrim(plan3_test_variant_id) <> pg_catalog.btrim(plan3_variant_id)
        ))
      );
  END IF;

  -- Prevent duplicate Variant IDs within Live Mode or within Test Mode
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'pricing_settings_intra_mode_unique_variants_chk'
      AND conrelid = 'public.pricing_settings'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.pricing_settings
      ADD CONSTRAINT pricing_settings_intra_mode_unique_variants_chk
      CHECK (
        (pg_catalog.btrim(plan1_variant_id) = '' OR (
          pg_catalog.btrim(plan1_variant_id) <> pg_catalog.btrim(plan2_variant_id) AND
          pg_catalog.btrim(plan1_variant_id) <> pg_catalog.btrim(plan3_variant_id)
        ))
        AND
        (pg_catalog.btrim(plan2_variant_id) = '' OR (
          pg_catalog.btrim(plan2_variant_id) <> pg_catalog.btrim(plan3_variant_id)
        ))
        AND
        (pg_catalog.btrim(plan1_test_variant_id) = '' OR (
          pg_catalog.btrim(plan1_test_variant_id) <> pg_catalog.btrim(plan2_test_variant_id) AND
          pg_catalog.btrim(plan1_test_variant_id) <> pg_catalog.btrim(plan3_test_variant_id)
        ))
        AND
        (pg_catalog.btrim(plan2_test_variant_id) = '' OR (
          pg_catalog.btrim(plan2_test_variant_id) <> pg_catalog.btrim(plan3_test_variant_id)
        ))
      );
  END IF;
END;
$$;

-- 2. Harden public.payments with status, resource tracking, plan/days compatibility,
--    entitlement provenance ledger columns, refund resolution tracking, and amount integrity
ALTER TABLE public.payments
  ADD COLUMN IF NOT EXISTS plan_number smallint,
  ADD COLUMN IF NOT EXISTS days_added integer,
  ADD COLUMN IF NOT EXISTS variant_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS order_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS subscription_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS customer_email text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT 'paid',
  ADD COLUMN IF NOT EXISTS store_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resource_type text NOT NULL DEFAULT 'orders',
  ADD COLUMN IF NOT EXISTS resource_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS event_name text NOT NULL DEFAULT 'order_created',
  ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS previous_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS effective_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS granted_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS entitlement_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS refund_resolution_status text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS refund_resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS refund_resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT pg_catalog.now();

-- Backfill plan_number and days_added from original NOT NULL columns (plan, days)
-- for any pre-existing records created under 20261106011734_lemon_squeezy_payments.sql
UPDATE public.payments
SET plan_number = plan
WHERE plan_number IS NULL;

UPDATE public.payments
SET days_added = days
WHERE days_added IS NULL;

-- Mark any pre-existing legacy payments that lack granted_expires_at provenance as 'legacy_untracked'
-- so automated entitlement revocation never guesses or subtracts days blindly on old records.
UPDATE public.payments
SET entitlement_status = 'legacy_untracked'
WHERE granted_expires_at IS NULL
  AND entitlement_status = 'active';

ALTER TABLE public.payments
  ALTER COLUMN plan_number SET NOT NULL,
  ALTER COLUMN days_added SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payments_amount_non_negative_chk'
      AND conrelid = 'public.payments'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_amount_non_negative_chk
      CHECK (amount > 0 AND refunded_amount >= 0 AND refunded_amount <= amount);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payments_plan_consistency_chk'
      AND conrelid = 'public.payments'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_plan_consistency_chk
      CHECK (plan BETWEEN 1 AND 3 AND plan_number BETWEEN 1 AND 3 AND plan_number = plan);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payments_days_added_range_chk'
      AND conrelid = 'public.payments'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_days_added_range_chk
      CHECK (days BETWEEN 1 AND 366 AND days_added BETWEEN 1 AND 366 AND days_added = days);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payments_status_chk'
      AND conrelid = 'public.payments'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_status_chk
      CHECK (payment_status IN ('paid', 'partially_refunded', 'refunded', 'disputed'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payments_entitlement_status_chk'
      AND conrelid = 'public.payments'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_entitlement_status_chk
      CHECK (entitlement_status IN ('active', 'revoked', 'partially_adjusted', 'retained_by_admin', 'legacy_untracked'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payments_refund_resolution_status_chk'
      AND conrelid = 'public.payments'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payments
      ADD CONSTRAINT payments_refund_resolution_status_chk
      CHECK (refund_resolution_status IN ('none', 'pending_admin_review', 'full_refund_confirmed', 'partial_refund_confirmed', 'refund_rejected'));
  END IF;
END;
$$;

-- Prevent the same Lemon Squeezy resource (e.g. order ID or subscription-invoice ID)
-- from ever extending a subscription twice even if delivered under different event keys
CREATE UNIQUE INDEX IF NOT EXISTS payments_store_resource_unique_idx
  ON public.payments (store_id, resource_type, resource_id)
  WHERE store_id <> '' AND resource_id <> '';

-- 3. Extend public.processed_webhook_events (created in Phase 1 migration 20261106041500)
--    Preserves event_id, event_name, provider, processed_at and existing records,
--    while adding delivery_id, event_key, resource tracking, and status columns.
CREATE TABLE IF NOT EXISTS public.processed_webhook_events (
  event_id text PRIMARY KEY,
  event_name text NOT NULL,
  provider text NOT NULL DEFAULT 'lemonsqueezy',
  processed_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.processed_webhook_events
  ADD COLUMN IF NOT EXISTS delivery_id text,
  ADD COLUMN IF NOT EXISTS event_key text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resource_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resource_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS store_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'processed',
  ADD COLUMN IF NOT EXISTS result_code text NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT pg_catalog.now();

-- Backfill delivery_id and event_key from event_id for any pre-existing rows
UPDATE public.processed_webhook_events
SET delivery_id = event_id
WHERE delivery_id IS NULL OR pg_catalog.btrim(delivery_id) = '';

UPDATE public.processed_webhook_events
SET event_key = event_id
WHERE pg_catalog.btrim(event_key) = '';

ALTER TABLE public.processed_webhook_events
  ALTER COLUMN delivery_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS processed_webhook_events_delivery_id_uidx
  ON public.processed_webhook_events (delivery_id);

CREATE INDEX IF NOT EXISTS processed_webhook_events_event_key_idx
  ON public.processed_webhook_events (event_key);

ALTER TABLE public.processed_webhook_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.processed_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.processed_webhook_events TO authenticated;
GRANT ALL ON TABLE public.processed_webhook_events TO service_role;

DROP POLICY IF EXISTS "Admins can view processed webhook events" ON public.processed_webhook_events;
CREATE POLICY "Admins can view processed webhook events"
  ON public.processed_webhook_events
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- 4. Create public.payment_reconciliation_issues for unapplied/refunded/conflicting webhooks
--    IMPORTANT: refunded_amount is nullable (BIGINT NULL) so unknown/missing/invalid/fractional
--    refund amounts are stored as NULL (never conflated with a verified 0 refund), while
--    raw_refunded_amount and refund_type preserve the exact classification.
CREATE TABLE IF NOT EXISTS public.payment_reconciliation_issues (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key text NOT NULL,
  delivery_id text NOT NULL DEFAULT '',
  event_name text NOT NULL,
  resource_type text NOT NULL DEFAULT '',
  resource_id text NOT NULL DEFAULT '',
  store_id text NOT NULL DEFAULT '',
  user_id uuid,
  page_id uuid,
  variant_id text NOT NULL DEFAULT '',
  order_id text NOT NULL DEFAULT '',
  subscription_id text NOT NULL DEFAULT '',
  amount bigint NOT NULL DEFAULT 0,
  refunded_amount bigint,
  raw_refunded_amount text NOT NULL DEFAULT '',
  refund_type text NOT NULL DEFAULT 'none',
  currency text NOT NULL DEFAULT '',
  failure_reason text NOT NULL,
  raw_meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  resolved boolean NOT NULL DEFAULT false,
  resolution_action text NOT NULL DEFAULT 'pending',
  resolved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  resolution_notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE public.payment_reconciliation_issues
  ADD COLUMN IF NOT EXISTS resource_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS resource_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS store_id text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS raw_refunded_amount text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS refund_type text NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS resolution_action text NOT NULL DEFAULT 'pending';

ALTER TABLE public.payment_reconciliation_issues
  ALTER COLUMN amount TYPE bigint,
  ALTER COLUMN refunded_amount TYPE bigint,
  ALTER COLUMN refunded_amount DROP NOT NULL,
  ALTER COLUMN refunded_amount DROP DEFAULT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payment_reconciliation_issues_amounts_chk'
      AND conrelid = 'public.payment_reconciliation_issues'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payment_reconciliation_issues
      ADD CONSTRAINT payment_reconciliation_issues_amounts_chk
      CHECK (amount >= 0 AND (refunded_amount IS NULL OR refunded_amount >= 0));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payment_reconciliation_issues_refund_type_chk'
      AND conrelid = 'public.payment_reconciliation_issues'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payment_reconciliation_issues
      ADD CONSTRAINT payment_reconciliation_issues_refund_type_chk
      CHECK (refund_type IN ('none', 'full', 'partial', 'zero_verified', 'unknown_missing', 'invalid_unverified', 'fractional_requires_review'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conname = 'payment_reconciliation_issues_resolution_action_chk'
      AND conrelid = 'public.payment_reconciliation_issues'::pg_catalog.regclass
  ) THEN
    ALTER TABLE public.payment_reconciliation_issues
      ADD CONSTRAINT payment_reconciliation_issues_resolution_action_chk
      CHECK (resolution_action IN ('pending', 'confirm_full_refund', 'confirm_partial_refund', 'reject_refund', 'keep_under_review', 'acknowledge_only'));
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS payment_reconciliation_issues_event_reason_uidx
  ON public.payment_reconciliation_issues (event_key, failure_reason);

CREATE INDEX IF NOT EXISTS payment_reconciliation_issues_unresolved_idx
  ON public.payment_reconciliation_issues (resolved, created_at DESC);

ALTER TABLE public.payment_reconciliation_issues ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.payment_reconciliation_issues FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.payment_reconciliation_issues TO authenticated;
GRANT ALL ON TABLE public.payment_reconciliation_issues TO service_role;

DROP POLICY IF EXISTS "Admins can view payment reconciliation issues" ON public.payment_reconciliation_issues;
CREATE POLICY "Admins can view payment reconciliation issues"
  ON public.payment_reconciliation_issues
  FOR SELECT
  TO authenticated
  USING (public.is_admin());

-- 5. Remove obsolete 5-parameter public.record_lemon_payment(text, uuid, text, integer, text)
--    overload from 20261106011734 so no caller can bypass mode isolation, page ownership,
--    or monetary reconciliation checks.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'record_lemon_payment'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid) = 'p_event_key text, p_user_id uuid, p_variant_id text, p_amount integer, p_currency text'
  ) THEN
    REVOKE ALL ON FUNCTION public.record_lemon_payment(text, uuid, text, integer, text) FROM PUBLIC, anon, authenticated, service_role;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.record_lemon_payment(text, uuid, text, integer, text);

-- Replace public.record_lemon_payment with strict mode-isolated, positive-amount logic
-- and exact entitlement window provenance (previous_expires_at, effective_start_at, granted_expires_at)
CREATE OR REPLACE FUNCTION public.record_lemon_payment(
  p_event_key text,
  p_user_id uuid,
  p_page_id uuid,
  p_variant_id text,
  p_order_id text,
  p_subscription_id text,
  p_amount integer,
  p_currency text,
  p_customer_email text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_event_key text := pg_catalog.btrim(COALESCE(p_event_key, ''));
  v_variant_id text := pg_catalog.btrim(COALESCE(p_variant_id, ''));
  v_order_id text := pg_catalog.btrim(COALESCE(p_order_id, ''));
  v_subscription_id text := pg_catalog.btrim(COALESCE(p_subscription_id, ''));
  v_currency text := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_currency, '')));
  v_customer_email text := pg_catalog.left(pg_catalog.btrim(COALESCE(p_customer_email, '')), 320);
  v_settings public.pricing_settings%ROWTYPE;
  v_active_mode text;
  v_plan smallint := 0;
  v_days integer := 0;
  v_page_count integer := 0;
  v_target_page_id uuid;
  v_current_expires timestamptz;
  v_effective_start timestamptz;
  v_new_expires timestamptz;
  v_existing_payment public.payments%ROWTYPE;
BEGIN
  IF v_event_key = '' OR pg_catalog.char_length(v_event_key) > 128 THEN
    RETURN 'invalid_event_key';
  END IF;

  IF p_user_id IS NULL THEN
    RETURN 'missing_user';
  END IF;

  IF v_variant_id = '' OR v_variant_id !~ '^[0-9]{1,20}$' THEN
    RETURN 'invalid_variant';
  END IF;

  -- Paid subscription extensions MUST have a strictly positive minor-unit integer amount (> 0)
  IF p_amount IS NULL OR p_amount <= 0 THEN
    RETURN 'invalid_payment_amount';
  END IF;

  IF v_currency !~ '^[A-Z]{3}$' THEN
    RETURN 'invalid_currency';
  END IF;

  -- Only allow currencies whose minor-unit representation in Lemon Squeezy payloads
  -- is officially documented (USD, EUR, GBP, CAD, AUD in integer cents; JPY in integer yen).
  IF v_currency NOT IN ('USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY') THEN
    RETURN 'unverified_currency_unit_requires_review';
  END IF;

  -- Reject banned users before recording payment or extending page
  IF EXISTS (
    SELECT 1
    FROM public.banned_users
    WHERE user_id = p_user_id
  ) THEN
    RETURN 'user_banned';
  END IF;

  -- Serialize concurrent calls for the same payment event_key within this transaction
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_payment:' || v_event_key));

  IF v_order_id <> '' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_order:' || v_order_id));
  END IF;

  -- Check if already recorded by event_key
  SELECT *
  INTO v_existing_payment
  FROM public.payments
  WHERE event_key = v_event_key;

  IF FOUND THEN
    IF v_existing_payment.user_id = p_user_id
       AND (v_existing_payment.variant_id = v_variant_id OR v_existing_payment.variant_id = '')
       AND v_existing_payment.amount = p_amount
       AND pg_catalog.upper(v_existing_payment.currency) = v_currency THEN
      RETURN 'duplicate';
    ELSE
      RETURN 'duplicate_conflict';
    END IF;
  END IF;

  SELECT *
  INTO v_settings
  FROM public.pricing_settings
  WHERE id = 'global';

  IF NOT FOUND THEN
    RETURN 'missing_pricing_settings';
  END IF;

  IF pg_catalog.lower(pg_catalog.btrim(COALESCE(v_settings.payment_provider, 'lemonsqueezy'))) <> 'lemonsqueezy' THEN
    RETURN 'invalid_payment_provider';
  END IF;

  v_active_mode := pg_catalog.lower(
    COALESCE(
      NULLIF(pg_catalog.btrim(v_settings.payment_mode), ''),
      NULLIF(pg_catalog.btrim(v_settings.payment_provider_mode), ''),
      'disabled'
    )
  );

  IF NOT COALESCE(v_settings.payment_provider_enabled, false) OR v_active_mode = 'disabled' THEN
    RETURN 'provider_disabled';
  END IF;

  -- Enforce strict separation between Test Mode and Live Mode variant IDs
  IF (pg_catalog.btrim(v_settings.plan1_test_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan1_test_variant_id) IN (
        pg_catalog.btrim(v_settings.plan1_variant_id),
        pg_catalog.btrim(v_settings.plan2_variant_id),
        pg_catalog.btrim(v_settings.plan3_variant_id)
      ))
     OR (pg_catalog.btrim(v_settings.plan2_test_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan2_test_variant_id) IN (
        pg_catalog.btrim(v_settings.plan1_variant_id),
        pg_catalog.btrim(v_settings.plan2_variant_id),
        pg_catalog.btrim(v_settings.plan3_variant_id)
      ))
     OR (pg_catalog.btrim(v_settings.plan3_test_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan3_test_variant_id) IN (
        pg_catalog.btrim(v_settings.plan1_variant_id),
        pg_catalog.btrim(v_settings.plan2_variant_id),
        pg_catalog.btrim(v_settings.plan3_variant_id)
      )) THEN
    RETURN 'test_live_variant_collision';
  END IF;

  -- Enforce intra-mode uniqueness of Variant IDs
  IF v_active_mode = 'test' THEN
    IF (pg_catalog.btrim(v_settings.plan1_test_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan1_test_variant_id) IN (
          pg_catalog.btrim(v_settings.plan2_test_variant_id),
          pg_catalog.btrim(v_settings.plan3_test_variant_id)
        ))
       OR (pg_catalog.btrim(v_settings.plan2_test_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan2_test_variant_id) = pg_catalog.btrim(v_settings.plan3_test_variant_id)) THEN
      RETURN 'duplicate_variant_id';
    END IF;

    IF v_variant_id = pg_catalog.btrim(v_settings.plan1_test_variant_id) THEN
      v_plan := 1;
      v_days := v_settings.plan1_days;
    ELSIF v_variant_id = pg_catalog.btrim(v_settings.plan2_test_variant_id) THEN
      v_plan := 2;
      v_days := v_settings.plan2_days;
    ELSIF v_variant_id = pg_catalog.btrim(v_settings.plan3_test_variant_id) THEN
      v_plan := 3;
      v_days := v_settings.plan3_days;
    ELSE
      RETURN 'unknown_variant_for_test_mode';
    END IF;
  ELSIF v_active_mode = 'live' THEN
    IF (pg_catalog.btrim(v_settings.plan1_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan1_variant_id) IN (
          pg_catalog.btrim(v_settings.plan2_variant_id),
          pg_catalog.btrim(v_settings.plan3_variant_id)
        ))
       OR (pg_catalog.btrim(v_settings.plan2_variant_id) <> '' AND pg_catalog.btrim(v_settings.plan2_variant_id) = pg_catalog.btrim(v_settings.plan3_variant_id)) THEN
      RETURN 'duplicate_variant_id';
    END IF;

    IF v_variant_id = pg_catalog.btrim(v_settings.plan1_variant_id) THEN
      v_plan := 1;
      v_days := v_settings.plan1_days;
    ELSIF v_variant_id = pg_catalog.btrim(v_settings.plan2_variant_id) THEN
      v_plan := 2;
      v_days := v_settings.plan2_days;
    ELSIF v_variant_id = pg_catalog.btrim(v_settings.plan3_variant_id) THEN
      v_plan := 3;
      v_days := v_settings.plan3_days;
    ELSE
      RETURN 'unknown_variant_for_live_mode';
    END IF;
  ELSE
    RETURN 'invalid_payment_mode';
  END IF;

  IF v_plan < 1 OR v_plan > 3 THEN
    RETURN 'invalid_plan';
  END IF;

  IF v_days IS NULL OR v_days < 1 OR v_days > 366 THEN
    RETURN 'invalid_plan_days';
  END IF;

  -- Lock the target page row FOR UPDATE to prevent race conditions during concurrent webhooks
  IF p_page_id IS NOT NULL THEN
    SELECT id, expires_at
    INTO v_target_page_id, v_current_expires
    FROM public.pages
    WHERE id = p_page_id
      AND user_id = p_user_id
    FOR UPDATE;

    IF v_target_page_id IS NULL THEN
      RETURN 'page_ownership_mismatch';
    END IF;
  ELSE
    SELECT pg_catalog.count(*)
    INTO v_page_count
    FROM public.pages
    WHERE user_id = p_user_id;

    IF v_page_count = 0 THEN
      RETURN 'missing_page';
    ELSIF v_page_count > 1 THEN
      RETURN 'ambiguous_page_selection';
    END IF;

    SELECT id, expires_at
    INTO v_target_page_id, v_current_expires
    FROM public.pages
    WHERE user_id = p_user_id
    LIMIT 1
    FOR UPDATE;

    IF v_target_page_id IS NULL THEN
      RETURN 'missing_page';
    END IF;
  END IF;

  v_effective_start := GREATEST(COALESCE(v_current_expires, pg_catalog.now()), pg_catalog.now());
  v_new_expires := v_effective_start + pg_catalog.make_interval(days => v_days);

  BEGIN
    INSERT INTO public.payments (
      event_key,
      user_id,
      page_id,
      plan,
      plan_number,
      variant_id,
      days,
      days_added,
      order_id,
      subscription_id,
      amount,
      currency,
      customer_email,
      payment_status,
      previous_expires_at,
      effective_start_at,
      granted_expires_at,
      entitlement_status,
      refund_resolution_status,
      updated_at
    )
    VALUES (
      v_event_key,
      p_user_id,
      v_target_page_id,
      v_plan,
      v_plan,
      v_variant_id,
      v_days,
      v_days,
      v_order_id,
      v_subscription_id,
      p_amount,
      v_currency,
      v_customer_email,
      'paid',
      v_current_expires,
      v_effective_start,
      v_new_expires,
      'active',
      'none',
      pg_catalog.now()
    );
  EXCEPTION WHEN unique_violation THEN
    RETURN 'duplicate';
  END;

  -- Update ONLY is_trial = false and expires_at on public.pages.
  -- NEVER alter is_active so an admin-suspended page (is_active = false) remains suspended.
  UPDATE public.pages
  SET is_trial = false,
      expires_at = v_new_expires
  WHERE id = v_target_page_id;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.record_lemon_payment(text, uuid, uuid, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_lemon_payment(text, uuid, uuid, text, text, text, integer, text, text) TO service_role;

-- 6. Atomic webhook wrapper: delivery deduplication + resource lock + payment recording + reconciliation logging
--    Closes AUD-04: Never exits early without recording security/mode/store rejections atomically in
--    payment_reconciliation_issues and processed_webhook_events.
CREATE OR REPLACE FUNCTION public.process_lemon_payment_webhook(
  p_delivery_id text,
  p_event_key text,
  p_event_name text,
  p_resource_type text,
  p_resource_id text,
  p_store_id text,
  p_test_mode boolean,
  p_user_id uuid,
  p_page_id uuid,
  p_variant_id text,
  p_order_id text,
  p_subscription_id text,
  p_amount integer,
  p_currency text,
  p_customer_email text,
  p_raw_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery_id text := pg_catalog.btrim(COALESCE(p_delivery_id, ''));
  v_event_key text := pg_catalog.btrim(COALESCE(p_event_key, ''));
  v_event_name text := pg_catalog.btrim(COALESCE(p_event_name, ''));
  v_store_id text := pg_catalog.btrim(COALESCE(p_store_id, ''));
  v_resource_type text := pg_catalog.btrim(COALESCE(p_resource_type, ''));
  v_resource_id text := pg_catalog.btrim(COALESCE(p_resource_id, ''));
  v_settings public.pricing_settings%ROWTYPE;
  v_active_mode text;
  v_expected_store_id text := '';
  v_security_reject_reason text := NULL;
  v_result text;
BEGIN
  IF v_delivery_id = '' OR v_event_key = '' THEN
    RETURN 'invalid_delivery_or_event_key';
  END IF;

  IF v_store_id = '' OR v_store_id !~ '^[0-9]{1,20}$' THEN
    RETURN 'invalid_store_id';
  END IF;

  IF v_resource_type = '' THEN
    RETURN 'missing_resource_type';
  END IF;

  IF v_resource_id = '' OR v_resource_id !~ '^[0-9]{1,24}$' THEN
    RETURN 'invalid_resource_id';
  END IF;

  IF NOT (
    (v_event_name = 'order_created' AND v_resource_type = 'orders')
    OR (v_event_name = 'subscription_payment_success' AND v_resource_type = 'subscription-invoices')
  ) THEN
    RETURN 'invalid_resource_type_for_event';
  END IF;

  -- Acquire transaction-scoped advisory locks on delivery_id, event_key, AND financial resource
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_wh_delivery:' || v_delivery_id));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_wh_event:' || v_event_key));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_resource:' || v_store_id || ':' || v_resource_type || ':' || v_resource_id));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_resource_id:' || v_store_id || ':' || v_resource_id));

  IF EXISTS (
    SELECT 1
    FROM public.processed_webhook_events
    WHERE delivery_id = v_delivery_id
       OR event_id = v_delivery_id
  ) THEN
    RETURN 'duplicate_delivery';
  END IF;

  -- Validate provider activation, mode, and Store ID against pricing_settings.
  -- IMPORTANT (AUD-04): Do NOT execute an early RETURN here. Instead, set v_security_reject_reason
  -- so the rejection is logged atomically in payment_reconciliation_issues and processed_webhook_events
  -- without extending any subscription or inserting any payment.
  SELECT *
  INTO v_settings
  FROM public.pricing_settings
  WHERE id = 'global';

  IF NOT FOUND THEN
    v_security_reject_reason := 'missing_pricing_settings';
  ELSE
    v_active_mode := pg_catalog.lower(
      COALESCE(
        NULLIF(pg_catalog.btrim(v_settings.payment_mode), ''),
        NULLIF(pg_catalog.btrim(v_settings.payment_provider_mode), ''),
        'disabled'
      )
    );

    IF NOT COALESCE(v_settings.payment_provider_enabled, false) OR v_active_mode = 'disabled' THEN
      v_security_reject_reason := 'provider_disabled_in_db';
    ELSIF (v_active_mode = 'test' AND COALESCE(p_test_mode, false) = false)
       OR (v_active_mode = 'live' AND COALESCE(p_test_mode, false) = true) THEN
      v_security_reject_reason := 'webhook_mode_mismatch';
    ELSE
      IF v_active_mode = 'test' THEN
        v_expected_store_id := pg_catalog.btrim(COALESCE(v_settings.lemon_test_store_id, ''));
      ELSIF v_active_mode = 'live' THEN
        v_expected_store_id := pg_catalog.btrim(COALESCE(NULLIF(pg_catalog.btrim(v_settings.lemon_store_id), ''), v_settings.store_id, ''));
      END IF;

      IF v_expected_store_id <> '' AND v_expected_store_id <> v_store_id THEN
        v_security_reject_reason := 'store_id_mismatch';
      END IF;
    END IF;
  END IF;

  IF v_security_reject_reason IS NOT NULL THEN
    -- Security/configuration rejection path: never touch payments or pages
    v_result := v_security_reject_reason;
  ELSE
    -- Prevent cross-event duplicate extension for the same (store_id, resource_type, resource_id)
    IF EXISTS (
      SELECT 1
      FROM public.payments
      WHERE store_id = v_store_id
        AND resource_type = v_resource_type
        AND resource_id = v_resource_id
        AND event_key <> v_event_key
    ) THEN
      INSERT INTO public.processed_webhook_events (
        event_id,
        delivery_id,
        event_key,
        event_name,
        provider,
        resource_type,
        resource_id,
        store_id,
        test_mode,
        processing_status,
        result_code,
        processed_at,
        created_at
      )
      VALUES (
        v_delivery_id,
        v_delivery_id,
        v_event_key,
        v_event_name,
        'lemonsqueezy',
        v_resource_type,
        v_resource_id,
        v_store_id,
        COALESCE(p_test_mode, false),
        'duplicate',
        'duplicate_resource',
        pg_catalog.now(),
        pg_catalog.now()
      );
      RETURN 'duplicate';
    END IF;

    -- Block any attempt (even via direct RPC invocation) to record a payment or extend a page
    -- when fractional minor units or monetary reconciliation flags exist in p_raw_meta.
    IF COALESCE((p_raw_meta->>'has_fractional_minor_units')::boolean, false) = true
       OR COALESCE(pg_catalog.btrim(p_raw_meta->>'fractional_minor_part'), '') <> ''
       OR COALESCE(pg_catalog.btrim(p_raw_meta->>'reconciliation_reason'), '') <> ''
       OR COALESCE(pg_catalog.btrim(p_raw_meta->>'provider_total_raw'), '') ~ '^[0-9]+\.[0-9]*[1-9]' THEN
      v_result := COALESCE(
        NULLIF(pg_catalog.btrim(p_raw_meta->>'reconciliation_reason'), ''),
        'fractional_minor_unit_requires_review'
      );
    ELSE
      v_result := public.record_lemon_payment(
        v_event_key,
        p_user_id,
        p_page_id,
        p_variant_id,
        p_order_id,
        p_subscription_id,
        p_amount,
        p_currency,
        p_customer_email
      );
    END IF;

    IF v_result = 'ok' THEN
      BEGIN
        UPDATE public.payments
        SET store_id = v_store_id,
            resource_type = v_resource_type,
            resource_id = v_resource_id,
            event_name = v_event_name
        WHERE event_key = v_event_key;
      EXCEPTION WHEN unique_violation THEN
        v_result := 'duplicate';
      END;
    END IF;
  END IF;

  -- If the payment could not be applied cleanly (and is not a benign duplicate),
  -- record a reconciliation issue atomically so no paid order or security mismatch is ever lost.
  -- IMPORTANT: For unapproved/fractional monetary issues, store amount = 0 (never a truncated amount),
  -- and store refunded_amount = NULL (not a refund).
  IF v_result NOT IN ('ok', 'duplicate') THEN
    INSERT INTO public.payment_reconciliation_issues (
      event_key,
      delivery_id,
      event_name,
      resource_type,
      resource_id,
      store_id,
      user_id,
      page_id,
      variant_id,
      order_id,
      subscription_id,
      amount,
      refunded_amount,
      raw_refunded_amount,
      refund_type,
      currency,
      failure_reason,
      raw_meta
    )
    VALUES (
      v_event_key,
      v_delivery_id,
      v_event_name,
      v_resource_type,
      v_resource_id,
      v_store_id,
      p_user_id,
      p_page_id,
      COALESCE(p_variant_id, ''),
      COALESCE(p_order_id, ''),
      COALESCE(p_subscription_id, ''),
      CASE
        WHEN v_result IN (
          'fractional_minor_unit_requires_review',
          'unverified_currency_unit_requires_review',
          'inconsistent_amount_breakdown_requires_review',
          'missing_amount_breakdown_requires_review',
          'formatted_total_mismatch_requires_review'
        ) THEN 0
        ELSE GREATEST(COALESCE(p_amount, 0), 0)
      END,
      NULL,
      '',
      'none',
      COALESCE(p_currency, ''),
      v_result,
      COALESCE(p_raw_meta, '{}'::jsonb)
    )
    ON CONFLICT (event_key, failure_reason) DO UPDATE
    SET delivery_id = EXCLUDED.delivery_id,
        raw_meta = EXCLUDED.raw_meta
    WHERE NOT public.payment_reconciliation_issues.resolved;
  END IF;

  INSERT INTO public.processed_webhook_events (
    event_id,
    delivery_id,
    event_key,
    event_name,
    provider,
    resource_type,
    resource_id,
    store_id,
    test_mode,
    processing_status,
    result_code,
    processed_at,
    created_at
  )
  VALUES (
    v_delivery_id,
    v_delivery_id,
    v_event_key,
    v_event_name,
    'lemonsqueezy',
    v_resource_type,
    v_resource_id,
    v_store_id,
    COALESCE(p_test_mode, false),
    CASE
      WHEN v_result IN ('ok', 'duplicate') THEN 'processed'
      ELSE 'reconciliation_required'
    END,
    v_result,
    pg_catalog.now(),
    pg_catalog.now()
  );

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.process_lemon_payment_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, integer, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_lemon_payment_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, integer, text, text, jsonb) TO service_role;

-- 7. Unified Atomic Lifecycle & Reconciliation Webhook Recorder (Closes AUD-02)
--    Drops any older 16-parameter signature first to avoid overload ambiguity.
DROP FUNCTION IF EXISTS public.process_lemon_lifecycle_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, integer, text, text, jsonb);

CREATE OR REPLACE FUNCTION public.process_lemon_lifecycle_webhook(
  p_delivery_id text,
  p_event_key text,
  p_event_name text,
  p_resource_type text,
  p_resource_id text,
  p_store_id text,
  p_test_mode boolean,
  p_user_id uuid,
  p_page_id uuid,
  p_variant_id text,
  p_order_id text,
  p_subscription_id text,
  p_amount bigint,
  p_refunded_amount bigint,
  p_raw_refunded_amount text,
  p_refund_type text,
  p_currency text,
  p_reason text,
  p_raw_meta jsonb DEFAULT '{}'::jsonb
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_delivery_id text := pg_catalog.btrim(COALESCE(p_delivery_id, ''));
  v_event_key text := pg_catalog.btrim(COALESCE(p_event_key, ''));
  v_event_name text := pg_catalog.btrim(COALESCE(p_event_name, ''));
  v_resource_type text := pg_catalog.btrim(COALESCE(p_resource_type, ''));
  v_resource_id text := pg_catalog.btrim(COALESCE(p_resource_id, ''));
  v_store_id text := pg_catalog.btrim(COALESCE(p_store_id, ''));
  v_reason text := pg_catalog.btrim(COALESCE(p_reason, 'lifecycle_event'));
  v_refund_type text := pg_catalog.btrim(COALESCE(p_refund_type, 'none'));
  v_raw_refunded text := pg_catalog.btrim(COALESCE(p_raw_refunded_amount, ''));
  v_persisted_refund_amount bigint := NULL;
BEGIN
  IF v_delivery_id = '' OR v_event_key = '' THEN
    RETURN 'invalid_delivery_or_event_key';
  END IF;

  IF v_Refund_Type NOT IN ('none', 'full', 'partial', 'zero_verified', 'unknown_missing', 'invalid_unverified', 'fractional_requires_review') THEN
    v_refund_type := 'invalid_unverified';
  END IF;

  -- Acquire transaction-scoped advisory locks on delivery_id, event_key, and resource
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_wh_delivery:' || v_delivery_id));
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_wh_event:' || v_event_key));
  IF v_store_id <> '' AND v_resource_id <> '' THEN
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('pag_resource:' || v_store_id || ':' || v_resource_type || ':' || v_resource_id));
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.processed_webhook_events
    WHERE delivery_id = v_delivery_id
       OR event_id = v_delivery_id
  ) THEN
    RETURN 'duplicate_delivery';
  END IF;

  -- Determine persisted_refund_amount without ever using 0 as a default for unknown/invalid/fractional refunds:
  -- - 'full' or 'partial': positive verified integer (> 0)
  -- - 'zero_verified': explicitly verified 0
  -- - 'unknown_missing', 'invalid_unverified', 'fractional_requires_review', 'none': NULL
  IF v_refund_type IN ('full', 'partial') AND p_refunded_amount IS NOT NULL AND p_refunded_amount > 0 THEN
    v_persisted_refund_amount := p_refunded_amount;
  ELSIF v_refund_type = 'zero_verified' THEN
    v_persisted_refund_amount := 0;
  ELSE
    v_persisted_refund_amount := NULL;
  END IF;

  -- Handle Refund Events:
  -- 1. Verified full or partial refund ('full' / 'partial' with v_persisted_refund_amount > 0):
  --    Updates payment_status ('refunded' or 'partially_refunded'), sets refunded_amount,
  --    and marks refund_resolution_status = 'pending_admin_review' so admin can review/revoke entitlement.
  -- 2. Unverified / zero / missing / fractional refund:
  --    NEVER overwrites payment_status to 'refunded'; marks refund_resolution_status = 'pending_admin_review'
  --    and records reconciliation issue with refunded_amount = NULL (or 0 for zero_verified).
  IF v_event_name IN ('order_refunded', 'subscription_payment_refunded')
     OR v_refund_type <> 'none'
     OR v_reason IN (
       'refund_requires_admin_review',
       'partial_refund_requires_admin_review',
       'refund_amount_unverified_requires_admin_review',
       'refund_amount_zero_requires_admin_review',
       'refund_amount_fractional_requires_admin_review'
     ) THEN
    IF v_refund_type IN ('full', 'partial') AND v_persisted_refund_amount IS NOT NULL AND v_persisted_refund_amount > 0 THEN
      UPDATE public.payments
      SET payment_status = CASE
            WHEN v_refund_type = 'partial' OR v_persisted_refund_amount < amount THEN 'partially_refunded'
            WHEN v_persisted_refund_amount >= amount AND amount > 0 THEN 'refunded'
            ELSE payment_status
          END,
          refunded_amount = LEAST(v_persisted_refund_amount::integer, amount),
          refund_resolution_status = 'pending_admin_review',
          updated_at = pg_catalog.now()
      WHERE (
        v_event_name = 'subscription_payment_refunded'
        AND resource_type = 'subscription-invoices'
        AND v_resource_id <> ''
        AND resource_id = v_resource_id
      )
      OR (
        v_event_name <> 'subscription_payment_refunded'
        AND (
          (v_resource_id <> '' AND resource_type = COALESCE(NULLIF(v_resource_type, ''), 'orders') AND resource_id = v_resource_id)
          OR (p_order_id IS NOT NULL AND p_order_id <> '' AND resource_type = 'orders' AND order_id = p_order_id)
        )
      );
    ELSE
      UPDATE public.payments
      SET refund_resolution_status = CASE
            WHEN refund_resolution_status = 'none' THEN 'pending_admin_review'
            ELSE refund_resolution_status
          END,
          updated_at = pg_catalog.now()
      WHERE (
        v_event_name = 'subscription_payment_refunded'
        AND resource_type = 'subscription-invoices'
        AND v_resource_id <> ''
        AND resource_id = v_resource_id
      )
      OR (
        v_event_name <> 'subscription_payment_refunded'
        AND (
          (v_resource_id <> '' AND resource_type = COALESCE(NULLIF(v_resource_type, ''), 'orders') AND resource_id = v_resource_id)
          OR (p_order_id IS NOT NULL AND p_order_id <> '' AND resource_type = 'orders' AND order_id = p_order_id)
        )
      );
    END IF;

    INSERT INTO public.payment_reconciliation_issues (
      event_key,
      delivery_id,
      event_name,
      resource_type,
      resource_id,
      store_id,
      user_id,
      page_id,
      variant_id,
      order_id,
      subscription_id,
      amount,
      refunded_amount,
      raw_refunded_amount,
      refund_type,
      currency,
      failure_reason,
      raw_meta
    )
    VALUES (
      v_event_key,
      v_delivery_id,
      v_event_name,
      v_resource_type,
      v_resource_id,
      v_store_id,
      p_user_id,
      p_page_id,
      COALESCE(p_variant_id, ''),
      COALESCE(p_order_id, ''),
      COALESCE(p_subscription_id, ''),
      GREATEST(COALESCE(p_amount, 0), 0),
      v_persisted_refund_amount,
      v_raw_refunded,
      v_refund_type,
      COALESCE(p_currency, ''),
      v_reason,
      COALESCE(p_raw_meta, '{}'::jsonb)
    )
    ON CONFLICT (event_key, failure_reason) DO UPDATE
    SET delivery_id = EXCLUDED.delivery_id,
        refunded_amount = COALESCE(EXCLUDED.refunded_amount, public.payment_reconciliation_issues.refunded_amount),
        raw_refunded_amount = CASE
          WHEN EXCLUDED.raw_refunded_amount <> '' THEN EXCLUDED.raw_refunded_amount
          ELSE public.payment_reconciliation_issues.raw_refunded_amount
        END,
        refund_type = CASE
          WHEN EXCLUDED.refund_type <> 'none' THEN EXCLUDED.refund_type
          ELSE public.payment_reconciliation_issues.refund_type
        END,
        raw_meta = EXCLUDED.raw_meta
    WHERE NOT public.payment_reconciliation_issues.resolved;
  ELSIF v_reason NOT IN (
    'initial_subscription_invoice_covered_by_order_created',
    'subscription_created',
    'subscription_updated',
    'subscription_cancelled',
    'subscription_expired',
    'subscription_resumed',
    'subscription_paused',
    'subscription_unpaused',
    'subscription_payment_recovered_no_double_extend'
  ) THEN
    -- Record any other monetary or custom_data reconciliation issue atomically
    INSERT INTO public.payment_reconciliation_issues (
      event_key,
      delivery_id,
      event_name,
      resource_type,
      resource_id,
      store_id,
      user_id,
      page_id,
      variant_id,
      order_id,
      subscription_id,
      amount,
      refunded_amount,
      raw_refunded_amount,
      refund_type,
      currency,
      failure_reason,
      raw_meta
    )
    VALUES (
      v_event_key,
      v_delivery_id,
      v_event_name,
      v_resource_type,
      v_resource_id,
      v_store_id,
      p_user_id,
      p_page_id,
      COALESCE(p_variant_id, ''),
      COALESCE(p_order_id, ''),
      COALESCE(p_subscription_id, ''),
      CASE
        WHEN v_reason IN (
          'fractional_minor_unit_requires_review',
          'unverified_currency_unit_requires_review',
          'inconsistent_amount_breakdown_requires_review',
          'missing_amount_breakdown_requires_review',
          'formatted_total_mismatch_requires_review'
        ) THEN 0
        ELSE GREATEST(COALESCE(p_amount, 0), 0)
      END,
      NULL,
      '',
      'none',
      COALESCE(p_currency, ''),
      v_reason,
      COALESCE(p_raw_meta, '{}'::jsonb)
    )
    ON CONFLICT (event_key, failure_reason) DO UPDATE
    SET delivery_id = EXCLUDED.delivery_id,
        raw_meta = EXCLUDED.raw_meta
    WHERE NOT public.payment_reconciliation_issues.resolved;
  END IF;

  INSERT INTO public.processed_webhook_events (
    event_id,
    delivery_id,
    event_key,
    event_name,
    provider,
    resource_type,
    resource_id,
    store_id,
    test_mode,
    processing_status,
    result_code,
    processed_at,
    created_at
  )
  VALUES (
    v_delivery_id,
    v_delivery_id,
    v_event_key,
    v_event_name,
    'lemonsqueezy',
    v_resource_type,
    v_resource_id,
    v_store_id,
    COALESCE(p_test_mode, false),
    'processed_lifecycle',
    v_reason,
    pg_catalog.now(),
    pg_catalog.now()
  );

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.process_lemon_lifecycle_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, bigint, bigint, text, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.process_lemon_lifecycle_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, bigint, bigint, text, text, text, text, jsonb) TO service_role;

-- 8. Admin RPC to Resolve Payment & Refund Reconciliation Issues (Closes AUD-03)
--    Supports explicit auditable decisions:
--      - 'confirm_full_refund'
--      - 'confirm_partial_refund'
--      - 'reject_refund'
--      - 'keep_under_review'
--      - 'acknowledge_only' (non-refund issues only)
--    Supports safe entitlement actions:
--      - 'keep_entitlement'
--      - 'revoke_if_safe' (restores exact pre-payment expiry ONLY when provenance is tracked
--        and no subsequent payment or extension exists on the page; NEVER subtracts days blindly)
DROP FUNCTION IF EXISTS public.admin_resolve_payment_reconciliation_issue(bigint, text);

CREATE OR REPLACE FUNCTION public.admin_resolve_payment_reconciliation_issue(
  p_issue_id bigint,
  p_resolution_notes text DEFAULT '',
  p_decision text DEFAULT 'acknowledge_only',
  p_verified_refund_amount bigint DEFAULT NULL,
  p_entitlement_action text DEFAULT 'keep_entitlement'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_admin_id uuid := auth.uid();
  v_notes text := pg_catalog.left(pg_catalog.btrim(COALESCE(p_resolution_notes, '')), 1000);
  v_decision text := pg_catalog.btrim(COALESCE(p_decision, 'acknowledge_only'));
  v_entitlement_action text := pg_catalog.btrim(COALESCE(p_entitlement_action, 'keep_entitlement'));
  v_issue public.payment_reconciliation_issues%ROWTYPE;
  v_payment public.payments%ROWTYPE;
  v_has_payment boolean := false;
  v_page public.pages%ROWTYPE;
  v_is_refund_issue boolean := false;
  v_prev_payment_status text := NULL;
  v_new_payment_status text := NULL;
  v_prev_refunded_amount integer := NULL;
  v_new_refunded_amount integer := NULL;
  v_prev_page_expires timestamptz := NULL;
  v_new_page_expires timestamptz := NULL;
  v_entitlement_revoked boolean := false;
  v_effective_refund bigint := 0;
BEGIN
  -- 1. Verify trusted administrator identity (never trusts user_metadata)
  IF NOT public.is_admin() OR v_admin_id IS NULL THEN
    RAISE EXCEPTION 'forbidden: admin access required' USING ERRCODE = '42501';
  END IF;

  IF v_notes = '' THEN
    RAISE EXCEPTION 'resolution_notes_required' USING ERRCODE = '22023';
  END IF;

  IF v_decision NOT IN ('confirm_full_refund', 'confirm_partial_refund', 'reject_refund', 'keep_under_review', 'acknowledge_only') THEN
    RAISE EXCEPTION 'invalid_resolution_decision' USING ERRCODE = '22023';
  END IF;

  IF v_entitlement_action NOT IN ('keep_entitlement', 'revoke_if_safe') THEN
    RAISE EXCEPTION 'invalid_entitlement_action' USING ERRCODE = '22023';
  END IF;

  -- 2. Lock reconciliation issue row FOR UPDATE
  SELECT *
  INTO v_issue
  FROM public.payment_reconciliation_issues
  WHERE id = p_issue_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'reconciliation issue not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_issue.resolved THEN
    RAISE EXCEPTION 'reconciliation issue already resolved' USING ERRCODE = 'P0001';
  END IF;

  v_is_refund_issue := (
    v_issue.refund_type <> 'none'
    OR v_issue.event_name IN ('order_refunded', 'subscription_payment_refunded')
    OR v_issue.failure_reason IN (
      'refund_requires_admin_review',
      'partial_refund_requires_admin_review',
      'refund_amount_unverified_requires_admin_review',
      'refund_amount_zero_requires_admin_review',
      'refund_amount_fractional_requires_admin_review'
    )
  );

  -- Prevent closing a refund issue with 'acknowledge_only' without an explicit financial decision
  IF v_is_refund_issue AND v_decision = 'acknowledge_only' THEN
    RAISE EXCEPTION 'explicit_refund_decision_required' USING ERRCODE = '22023';
  END IF;

  -- 3. Locate and lock the associated payment row FOR UPDATE (if applicable)
  SELECT *
  INTO v_payment
  FROM public.payments
  WHERE event_key = v_issue.event_key
     OR (v_issue.order_id <> '' AND order_id = v_issue.order_id AND resource_type = 'orders')
     OR (v_issue.resource_id <> '' AND resource_id = v_issue.resource_id AND (v_issue.resource_type = '' OR resource_type = v_issue.resource_type))
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  v_has_payment := FOUND;

  IF v_decision IN ('confirm_full_refund', 'confirm_partial_refund', 'reject_refund') THEN
    IF NOT v_has_payment THEN
      RAISE EXCEPTION 'linked_payment_not_found_for_refund_decision' USING ERRCODE = 'P0002';
    END IF;

    IF v_issue.user_id IS NOT NULL AND v_payment.user_id <> v_issue.user_id THEN
      RAISE EXCEPTION 'payment_user_mismatch' USING ERRCODE = '22023';
    END IF;

    IF v_issue.page_id IS NOT NULL AND v_payment.page_id IS NOT NULL AND v_payment.page_id <> v_issue.page_id THEN
      RAISE EXCEPTION 'payment_page_mismatch' USING ERRCODE = '22023';
    END IF;

    IF v_payment.refund_resolution_status = 'full_refund_confirmed' AND v_decision IN ('confirm_full_refund', 'confirm_partial_refund') THEN
      RAISE EXCEPTION 'payment_refund_already_confirmed' USING ERRCODE = 'P0001';
    END IF;

    v_prev_payment_status := v_payment.payment_status;
    v_prev_refunded_amount := v_payment.refunded_amount;
  END IF;

  -- 4. Handle 'keep_under_review' (updates notes & audit log without closing the issue)
  IF v_decision = 'keep_under_review' THEN
    UPDATE public.payment_reconciliation_issues
    SET resolution_action = 'keep_under_review',
        resolution_notes = v_notes,
        resolved_by = v_admin_id
    WHERE id = p_issue_id;

    IF v_has_payment THEN
      UPDATE public.payments
      SET refund_resolution_status = 'pending_admin_review',
          updated_at = pg_catalog.now()
      WHERE id = v_payment.id;
    END IF;

    PERFORM public.log_admin_action(
      'review_payment_reconciliation',
      COALESCE(v_payment.user_id, v_issue.user_id),
      'payment_reconciliation',
      v_issue.id::text,
      pg_catalog.jsonb_build_object(
        'reconciliation_issue_id', v_issue.id,
        'payment_id', v_payment.id,
        'page_id', COALESCE(v_payment.page_id, v_issue.page_id),
        'decision', v_decision,
        'entitlement_action', 'keep_entitlement',
        'previous_payment_status', v_prev_payment_status,
        'new_payment_status', v_prev_payment_status,
        'resolution_notes', pg_catalog.left(v_notes, 500)
      )
    );

    RETURN pg_catalog.jsonb_build_object(
      'status', 'kept_under_review',
      'issue_id', v_issue.id,
      'resolved', false
    );
  END IF;

  -- 5. Apply financial decision to public.payments
  IF v_decision = 'confirm_full_refund' THEN
    v_effective_refund := COALESCE(p_verified_refund_amount, v_issue.refunded_amount, v_payment.amount::bigint);
    IF v_effective_refund <= 0 OR v_effective_refund <> v_payment.amount THEN
      RAISE EXCEPTION 'invalid_full_refund_amount' USING ERRCODE = '22023';
    END IF;

    v_new_payment_status := 'refunded';
    v_new_refunded_amount := v_payment.amount;

    UPDATE public.payments
    SET payment_status = v_new_payment_status,
        refunded_amount = v_new_refunded_amount,
        refund_resolution_status = 'full_refund_confirmed',
        refund_resolved_at = pg_catalog.now(),
        refund_resolved_by = v_admin_id,
        entitlement_status = CASE
          WHEN v_entitlement_action = 'keep_entitlement' AND entitlement_status = 'active' THEN 'retained_by_admin'
          ELSE entitlement_status
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_payment.id;

  ELSIF v_decision = 'confirm_partial_refund' THEN
    IF v_entitlement_action = 'revoke_if_safe' THEN
      RAISE EXCEPTION 'cannot_revoke_full_entitlement_on_partial_refund' USING ERRCODE = '22023';
    END IF;

    v_effective_refund := COALESCE(p_verified_refund_amount, v_issue.refunded_amount, 0);
    IF v_effective_refund <= 0 OR v_effective_refund >= v_payment.amount THEN
      RAISE EXCEPTION 'invalid_partial_refund_amount' USING ERRCODE = '22023';
    END IF;

    v_new_payment_status := 'partially_refunded';
    v_new_refunded_amount := v_effective_refund::integer;

    UPDATE public.payments
    SET payment_status = v_new_payment_status,
        refunded_amount = v_new_refunded_amount,
        refund_resolution_status = 'partial_refund_confirmed',
        refund_resolved_at = pg_catalog.now(),
        refund_resolved_by = v_admin_id,
        entitlement_status = CASE
          WHEN entitlement_status = 'active' THEN 'partially_adjusted'
          ELSE entitlement_status
        END,
        updated_at = pg_catalog.now()
    WHERE id = v_payment.id;

  ELSIF v_decision = 'reject_refund' THEN
    IF v_entitlement_action = 'revoke_if_safe' THEN
      RAISE EXCEPTION 'cannot_revoke_entitlement_when_rejecting_refund' USING ERRCODE = '22023';
    END IF;

    v_new_payment_status := 'paid';
    v_new_refunded_amount := 0;

    UPDATE public.payments
    SET payment_status = v_new_payment_status,
        refunded_amount = 0,
        refund_resolution_status = 'refund_rejected',
        refund_resolved_at = pg_catalog.now(),
        refund_resolved_by = v_admin_id,
        updated_at = pg_catalog.now()
    WHERE id = v_payment.id;
  END IF;

  -- 6. Safe, Provenance-Verified Entitlement Revocation (when p_entitlement_action = 'revoke_if_safe')
  IF v_entitlement_action = 'revoke_if_safe' THEN
    IF v_decision <> 'confirm_full_refund' THEN
      RAISE EXCEPTION 'entitlement_revocation_requires_full_refund' USING ERRCODE = '22023';
    END IF;

    IF v_payment.page_id IS NULL THEN
      RAISE EXCEPTION 'payment_missing_page_id_for_revocation' USING ERRCODE = 'P0002';
    END IF;

    IF v_payment.entitlement_status = 'revoked' THEN
      RAISE EXCEPTION 'entitlement_already_revoked' USING ERRCODE = 'P0001';
    END IF;

    -- Refuse to guess days on legacy untracked rows
    IF v_payment.entitlement_status = 'legacy_untracked'
       OR v_payment.granted_expires_at IS NULL
       OR v_payment.effective_start_at IS NULL THEN
      RAISE EXCEPTION 'entitlement_provenance_missing_requires_manual_review' USING ERRCODE = 'P0001';
    END IF;

    -- Lock the target page row FOR UPDATE
    SELECT *
    INTO v_page
    FROM public.pages
    WHERE id = v_payment.page_id
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'target_page_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Ensure no subsequent valid payment exists for the same page after this payment
    IF EXISTS (
      SELECT 1
      FROM public.payments p_later
      WHERE p_later.page_id = v_payment.page_id
        AND p_later.id <> v_payment.id
        AND p_later.payment_status IN ('paid', 'partially_refunded')
        AND p_later.created_at >= v_payment.created_at
    ) THEN
      RAISE EXCEPTION 'subsequent_payment_exists_cannot_revoke_entitlement' USING ERRCODE = 'P0001';
    END IF;

    -- Ensure the page's current expires_at was not extended beyond what this payment granted
    IF v_page.expires_at IS NOT NULL AND v_page.expires_at > v_payment.granted_expires_at THEN
      RAISE EXCEPTION 'subsequent_extension_detected_cannot_revoke_entitlement' USING ERRCODE = 'P0001';
    END IF;

    v_prev_page_expires := v_page.expires_at;
    v_new_page_expires := COALESCE(v_payment.previous_expires_at, v_payment.effective_start_at);

    UPDATE public.pages
    SET expires_at = v_new_page_expires
    WHERE id = v_page.id;

    UPDATE public.payments
    SET entitlement_status = 'revoked',
        updated_at = pg_catalog.now()
    WHERE id = v_payment.id;

    v_entitlement_revoked := true;
  END IF;

  -- 7. Mark reconciliation issue as resolved
  UPDATE public.payment_reconciliation_issues
  SET resolved = true,
      resolution_action = v_decision,
      resolved_by = v_admin_id,
      resolved_at = pg_catalog.now(),
      resolution_notes = v_notes,
      refunded_amount = CASE
        WHEN v_decision IN ('confirm_full_refund', 'confirm_partial_refund') THEN v_new_refunded_amount::bigint
        WHEN v_decision = 'reject_refund' THEN 0
        ELSE refunded_amount
      END
  WHERE id = p_issue_id;

  -- 8. Record mandatory audit log entry in the same transaction
  PERFORM public.log_admin_action(
    'resolve_payment_reconciliation',
    COALESCE(v_payment.user_id, v_issue.user_id),
    'payment_reconciliation',
    v_issue.id::text,
    pg_catalog.jsonb_build_object(
      'reconciliation_issue_id', v_issue.id,
      'payment_id', v_payment.id,
      'page_id', COALESCE(v_payment.page_id, v_issue.page_id),
      'event_key', v_issue.event_key,
      'event_name', v_issue.event_name,
      'failure_reason', v_issue.failure_reason,
      'decision', v_decision,
      'entitlement_action', v_entitlement_action,
      'entitlement_revoked', v_entitlement_revoked,
      'previous_payment_status', v_prev_payment_status,
      'new_payment_status', v_new_payment_status,
      'previous_refunded_amount', v_prev_refunded_amount,
      'new_refunded_amount', v_new_refunded_amount,
      'previous_expires_at', v_prev_page_expires,
      'new_expires_at', v_new_page_expires,
      'currency', v_issue.currency,
      'resolution_notes', pg_catalog.left(v_notes, 500)
    )
  );

  RETURN pg_catalog.jsonb_build_object(
    'status', 'resolved',
    'issue_id', v_issue.id,
    'payment_id', v_payment.id,
    'decision', v_decision,
    'payment_status', v_new_payment_status,
    'refunded_amount', v_new_refunded_amount,
    'entitlement_revoked', v_entitlement_revoked,
    'previous_expires_at', v_prev_page_expires,
    'new_expires_at', v_new_page_expires
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_payment_reconciliation_issue(bigint, text, text, bigint, text) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_payment_reconciliation_issue(bigint, text, text, bigint, text) TO authenticated;

-- 9. Per-User Checkout Rate Limiting & Ban Verification RPC (service_role only)
CREATE OR REPLACE FUNCTION public.check_checkout_rate_limit(
  p_user_id uuid,
  p_page_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_window_1m bigint;
  v_bucket text;
  v_count integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN 'missing_user';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.banned_users
    WHERE user_id = p_user_id
  ) THEN
    RETURN 'user_banned';
  END IF;

  v_window_1m := (EXTRACT(EPOCH FROM pg_catalog.now())::bigint / 60);
  v_bucket := 'checkout_user:' || p_user_id::text || ':' || v_window_1m::text;

  INSERT INTO public.rate_limit_buckets (bucket_key, request_count, last_seen)
  VALUES (v_bucket, 1, pg_catalog.now())
  ON CONFLICT (bucket_key) DO UPDATE
  SET request_count = public.rate_limit_buckets.request_count + 1,
      last_seen = pg_catalog.now()
  RETURNING request_count INTO v_count;

  IF v_count > 5 THEN
    RETURN 'rate_limited';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE ALL ON FUNCTION public.check_checkout_rate_limit(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_checkout_rate_limit(uuid, uuid) TO service_role;

-- 10. Operational Cleanup Policy for Ephemeral Rate-Limit Buckets Only
--     IMPORTANT DATA RETENTION POLICY:
--     - public.payments, public.processed_webhook_events, public.payment_reconciliation_issues,
--       and public.admin_audit_logs are permanent financial/security records and MUST NEVER
--       be purged automatically (deleting processed_webhook_events would allow replay attacks).
--     - Only public.rate_limit_buckets rows older than 24 hours are ephemeral and safe to clean up.
CREATE OR REPLACE FUNCTION public.cleanup_expired_rate_limit_buckets()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  DELETE FROM public.rate_limit_buckets
  WHERE last_seen < pg_catalog.now() - interval '24 hours';

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_rate_limit_buckets() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_rate_limit_buckets() TO service_role;
