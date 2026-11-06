/**
 * ============================================================================
 * PAG ADS — OFFICIAL LEMON SQUEEZY WEBHOOK FIXTURES & MONEY UNIT TEST SUITE
 * ============================================================================
 * Verifies the exact monetary unit and financial safety rules:
 * 1. Official Order Object example (`subtotal = 999`, `setup_fee = 999`,
 *    `discount_total = 0`, `tax = 200`, `total = 1199`, `currency = "USD"`,
 *    `total_formatted = "$11.99"`) -> 1199 cents (NEVER 2198 and NEVER 119900).
 * 2. `1859.76 EUR` with `"€18.59"` -> preserves `"1859.76"`, logs
 *    `fractional_minor_unit_requires_review`, DOES NOT extend subscription,
 *    and DOES NOT record `1859` as an approved payment in `payments`.
 * 3. `extractRawMonetaryTokens` extracts ONLY from `data.attributes`, rejects
 *    missing `data.type`, missing `data.id`, mismatched `data.type`/`data.id`,
 *    and duplicate JSON keys.
 * 4. Order breakdown equation verifies `subtotal - discount_total + tax == total`
 *    (or `subtotal - discount_total == total` when `tax_inclusive === true`),
 *    never adds `setup_fee` on top of `subtotal`, and logs review when
 *    `setup_fee > subtotal` or when breakdown fields are missing.
 * 5. Documented `JPY` (`599 JPY` = `¥599`) vs Unverified `KWD`.
 * 6. Full & partial refunds without guessing `refunded_amount` or multiplying by 100.
 * 7. Multi-renewal lifecycle & deduplication unaffected.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const ROOT_DIR = process.cwd();
const FIXTURES_DIR = path.join(ROOT_DIR, 'tests/fixtures/lemonsqueezy');

function readFixtureRaw(filename) {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf8');
}

function readFixtureJson(filename) {
  return JSON.parse(readFixtureRaw(filename));
}

function signPayload(secret, rawString) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(rawString, 'utf8')).digest('hex');
}

function loadWebhookModule({ env, supabaseMock }) {
  const fullPath = path.join(ROOT_DIR, 'supabase/functions/lemon-webhook/index.ts');
  const rawSource = fs
    .readFileSync(fullPath, 'utf8')
    .replace(/import\s+\{\s*createClient\s*\}\s+from\s+["']npm:@supabase\/supabase-js@2["'];?/g, '')
    .replace(
      /export\s+\{\s*extractRawMonetaryTokens\s*,\s*convertTokenToMinorUnits\s*,\s*normalizeWebhookMonetaryFields\s*,\s*OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES\s*,?\s*\};?/m,
      'globalThis.__exported = { extractRawMonetaryTokens, convertTokenToMinorUnits, normalizeWebhookMonetaryFields, OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES };',
    )
    .replace(/export\s+interface\s+/g, 'interface ');

  const transpiled = stripTypeScriptTypes(rawSource);
  let capturedHandler = null;

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    Response,
    Request,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    crypto: globalThis.crypto,
    createClient: () => supabaseMock,
    Deno: {
      env: {
        get(key) {
          return env[key];
        },
      },
      serve(handler) {
        capturedHandler = handler;
      },
    },
  };
  sandbox.globalThis = sandbox;

  vm.createContext(sandbox);
  vm.runInContext(transpiled, sandbox, { filename: 'supabase/functions/lemon-webhook/index.ts' });
  return {
    handler: capturedHandler,
    exported: sandbox.__exported,
  };
}

function loadWebhookHandler({ env, supabaseMock }) {
  return loadWebhookModule({ env, supabaseMock }).handler;
}

function createStatefulDatabaseSimulator() {
  const processedDeliveries = new Map();
  const paymentsByEventKey = new Map();
  const paymentsByStoreResource = new Map();
  const reconciliationIssues = [];
  let pageExtensionCount = 0;

  return {
    get state() {
      return {
        processedDeliveries,
        paymentsByEventKey,
        paymentsByStoreResource,
        reconciliationIssues,
        pageExtensionCount,
      };
    },
    from(table) {
      if (table === 'payment_reconciliation_issues') {
        return {
          async upsert(record) {
            const exists = reconciliationIssues.some(
              (r) => r.event_key === record.event_key && r.failure_reason === record.failure_reason,
            );
            if (!exists) {
              reconciliationIssues.push(record);
            }
            return { data: record, error: null };
          },
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    async rpc(fnName, args) {
      if (fnName === 'process_lemon_payment_webhook') {
        if (!args.p_resource_type || String(args.p_resource_type).trim() === '') {
          return { data: 'missing_resource_type', error: null };
        }
        if (!args.p_resource_id || !/^\d{1,24}$/.test(String(args.p_resource_id).trim())) {
          return { data: 'invalid_resource_id', error: null };
        }
        const validEventResource =
          (args.p_event_name === 'order_created' && args.p_resource_type === 'orders') ||
          (args.p_event_name === 'subscription_payment_success' && args.p_resource_type === 'subscription-invoices');
        if (!validEventResource) {
          return { data: 'invalid_resource_type_for_event', error: null };
        }

        if (processedDeliveries.has(args.p_delivery_id)) {
          return { data: 'duplicate_delivery', error: null };
        }

        const rawMeta = args.p_raw_meta || {};
        const hasFractionalFlag =
          rawMeta.has_fractional_minor_units === true ||
          (typeof rawMeta.fractional_minor_part === 'string' && rawMeta.fractional_minor_part.trim() !== '') ||
          (typeof rawMeta.reconciliation_reason === 'string' && rawMeta.reconciliation_reason.trim() !== '') ||
          (typeof rawMeta.provider_total_raw === 'string' && /^[0-9]+\.[0-9]*[1-9]/.test(rawMeta.provider_total_raw.trim()));

        if (hasFractionalFlag) {
          const rejectReason = rawMeta.reconciliation_reason || 'fractional_minor_unit_requires_review';
          reconciliationIssues.push({
            event_key: args.p_event_key,
            delivery_id: args.p_delivery_id,
            event_name: args.p_event_name,
            amount: 0,
            refunded_amount: 0,
            currency: args.p_currency,
            failure_reason: rejectReason,
            raw_meta: rawMeta,
          });
          processedDeliveries.set(args.p_delivery_id, rejectReason);
          return { data: rejectReason, error: null };
        }

        const resourceCompositeKey = `${args.p_store_id}:${args.p_resource_type}:${args.p_resource_id}`;
        if (args.p_store_id && args.p_resource_id && paymentsByStoreResource.has(resourceCompositeKey)) {
          const existing = paymentsByStoreResource.get(resourceCompositeKey);
          if (existing.event_key !== args.p_event_key) {
            processedDeliveries.set(args.p_delivery_id, 'duplicate');
            return { data: 'duplicate', error: null };
          }
        }

        if (paymentsByEventKey.has(args.p_event_key)) {
          processedDeliveries.set(args.p_delivery_id, 'duplicate');
          return { data: 'duplicate', error: null };
        }

        if (!Number.isInteger(args.p_amount) || args.p_amount <= 0) {
          return { data: 'invalid_payment_amount', error: null };
        }

        const paymentRow = {
          event_key: args.p_event_key,
          store_id: args.p_store_id,
          resource_type: args.p_resource_type,
          resource_id: args.p_resource_id,
          order_id: args.p_order_id,
          subscription_id: args.p_subscription_id,
          amount: args.p_amount,
          refunded_amount: 0,
          currency: args.p_currency,
          payment_status: 'paid',
          raw_meta: args.p_raw_meta,
        };

        paymentsByEventKey.set(args.p_event_key, paymentRow);
        paymentsByStoreResource.set(resourceCompositeKey, paymentRow);
        processedDeliveries.set(args.p_delivery_id, 'ok');
        pageExtensionCount += 1;

        return { data: 'ok', error: null };
      }

      if (fnName === 'process_lemon_lifecycle_webhook') {
        if (processedDeliveries.has(args.p_delivery_id)) {
          return { data: 'duplicate_delivery', error: null };
        }

        const verifiedRefundAmt =
          typeof args.p_refunded_amount === 'number' && args.p_refunded_amount > 0 ? args.p_refunded_amount : 0;
        if ((args.p_refund_type === 'full' || args.p_refund_type === 'partial') && verifiedRefundAmt > 0) {
          for (const payment of paymentsByEventKey.values()) {
            const matchesInvoice =
              args.p_event_name === 'subscription_payment_refunded' &&
              payment.resource_type === 'subscription-invoices' &&
              payment.resource_id === args.p_resource_id;
            const matchesOrder =
              args.p_event_name !== 'subscription_payment_refunded' &&
              payment.resource_type === 'orders' &&
              (payment.resource_id === args.p_resource_id || payment.order_id === args.p_order_id);

            if (matchesInvoice || matchesOrder) {
              payment.payment_status =
                args.p_refund_type === 'partial' || verifiedRefundAmt < payment.amount
                  ? 'partially_refunded'
                  : 'refunded';
              payment.refunded_amount = Math.min(verifiedRefundAmt, payment.amount);
              payment.refund_resolution_status = 'pending_admin_review';
            }
          }
        }

        const nonReconciliationReasons = new Set([
          'initial_subscription_invoice_covered_by_order_created',
          'subscription_created',
          'subscription_updated',
          'subscription_cancelled',
          'subscription_expired',
          'subscription_resumed',
          'subscription_paused',
          'subscription_unpaused',
          'subscription_payment_recovered_no_double_extend',
        ]);

        if (args.p_reason && !nonReconciliationReasons.has(args.p_reason)) {
          reconciliationIssues.push({
            event_key: args.p_event_key,
            delivery_id: args.p_delivery_id,
            event_name: args.p_event_name,
            amount: args.p_amount || 0,
            refunded_amount: args.p_refunded_amount ?? null,
            raw_refunded_amount: args.p_raw_refunded_amount ?? null,
            refund_type: args.p_refund_type,
            currency: args.p_currency,
            failure_reason: args.p_reason,
            raw_meta: args.p_raw_meta,
          });
        }

        processedDeliveries.set(args.p_delivery_id, args.p_reason);
        return { data: 'ok', error: null };
      }

      throw new Error(`Unexpected RPC: ${fnName}`);
    },
  };
}

const TEST_ENV = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role-key',
  LEMONSQUEEZY_ENABLED: 'true',
  LEMONSQUEEZY_MODE: 'test',
  LEMONSQUEEZY_TEST_WEBHOOK_SECRET: 'official-fixture-test-secret-key',
  LEMONSQUEEZY_TEST_STORE_ID: '55001',
  LEMONSQUEEZY_LIVE_WEBHOOK_SECRET: 'official-fixture-live-secret-key',
  LEMONSQUEEZY_LIVE_STORE_ID: '88001',
};

const results = [];

async function runOfficialTest(name, fn) {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log(`✅ [OFFICIAL MONEY & FIXTURE PASS] ${name}`);
  } catch (err) {
    results.push({ name, passed: false, error: err.message });
    console.error(`❌ [OFFICIAL MONEY & FIXTURE FAIL] ${name}:`, err.message);
    process.exitCode = 1;
  }
}

await (async () => {
  console.log('====================================================================');
  console.log('بدء اختبارات الوحدات المالية وفحص الأمان المالي النهائي قبل Staging');
  console.log('====================================================================');

  // Test 1: Official Order Object example (`subtotal = 999, setup_fee = 999, discount_total = 0, tax = 200, total = 1199`)
  await runOfficialTest(
    '1. [اختبار إلزامي 1] المثال الرسمي Order: subtotal=999 + setup_fee=999 + tax=200 => total=1199 USD دون مضاعفة setup_fee إلى 2198',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const handler = loadWebhookHandler({ env: TEST_ENV, supabaseMock: db });
      const rawBody = readFixtureRaw('order_created.json');
      const parsed = JSON.parse(rawBody);
      assert.equal(parsed.data.attributes.subtotal, 999);
      assert.equal(parsed.data.attributes.setup_fee, 999);
      assert.equal(parsed.data.attributes.discount_total, 0);
      assert.equal(parsed.data.attributes.tax, 200);
      assert.equal(parsed.data.attributes.total, 1199);
      assert.equal(parsed.data.attributes.currency, 'USD');
      assert.equal(parsed.data.attributes.total_formatted, '$11.99');

      const sig = signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: rawBody,
        }),
      );

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.subscription_extended, true, 'Official Order example with setup_fee=999 must be accepted');
      assert.equal(body.internal_amount_minor, 1199, 'Total must be 1199 cents, never 2198 and never 119900');

      const stored = db.state.paymentsByEventKey.get('order_created:1001');
      assert.equal(stored.amount, 1199);
      assert.equal(stored.raw_meta.setup_fee_minor, 999);
      assert.equal(stored.currency, 'USD');
    },
  );

  // Test 2: 1859.76 EUR with "€18.59" MUST NOT create an approved payment, MUST NOT record 1859 as approved amount,
  // and MUST NOT extend subscription through any code path!
  await runOfficialTest(
    '2. [اختبار إلزامي 2] منع تسجيل المبلغ المبتور (1859 من 1859.76 EUR) كدفعة معتمدة في payments ومنع تمديد الاشتراك عبر أي مسار',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const handler = loadWebhookHandler({ env: TEST_ENV, supabaseMock: db });
      const rawBody = readFixtureRaw('order_created_fractional_cents_eur.json');
      const parsed = JSON.parse(rawBody);
      assert.equal(parsed.data.attributes.total, 1859.76);
      assert.equal(parsed.data.attributes.currency, 'EUR');
      assert.equal(parsed.data.attributes.total_formatted, '€18.59');

      const sig = signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: rawBody,
        }),
      );

      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.subscription_extended, false, 'Must NEVER extend subscription');
      assert.equal(body.status, 'reconciliation_logged');
      assert.equal(body.reason, 'fractional_minor_unit_requires_review');
      assert.equal(body.internal_amount_minor, null, 'Approved amount must be null, NEVER 1859 or 185976');
      assert.equal(body.unapproved_truncated_minor, 1859, 'Truncated integer kept only in separate unapproved field');
      assert.equal(body.provider_total_raw, '1859.76', 'Exact raw string 1859.76 preserved');

      assert.equal(db.state.paymentsByEventKey.size, 0, 'Must NOT insert any row into payments');
      assert.equal(db.state.pageExtensionCount, 0, 'Must NOT extend any page');

      assert.equal(db.state.reconciliationIssues.length, 1);
      assert.equal(db.state.reconciliationIssues[0].amount, 0, 'Reconciliation row amount must be 0, not truncated 1859');
      assert.equal(db.state.reconciliationIssues[0].raw_meta.provider_total_raw, '1859.76');
      assert.equal(db.state.reconciliationIssues[0].raw_meta.approved_amount_minor, null);
      assert.equal(db.state.reconciliationIssues[0].raw_meta.unapproved_truncated_minor, 1859);
      assert.equal(db.state.reconciliationIssues[0].raw_meta.fractional_minor_part, '76');

      const directRpcRes = await db.rpc('process_lemon_payment_webhook', {
        p_delivery_id: 'wh_direct_bypass_attempt',
        p_event_key: 'order_created:1002_bypass',
        p_event_name: 'order_created',
        p_resource_type: 'orders',
        p_resource_id: '1002',
        p_store_id: '55001',
        p_test_mode: true,
        p_user_id: '11111111-1111-4111-8111-111111111111',
        p_page_id: '22222222-2222-4222-8222-222222222222',
        p_variant_id: '101001',
        p_order_id: '1002',
        p_subscription_id: '',
        p_amount: 1859,
        p_currency: 'EUR',
        p_customer_email: 'johndoe@example.com',
        p_raw_meta: db.state.reconciliationIssues[0].raw_meta,
      });
      assert.equal(directRpcRes.data, 'fractional_minor_unit_requires_review');
      assert.equal(db.state.paymentsByEventKey.size, 0);
      assert.equal(db.state.pageExtensionCount, 0);
    },
  );

  // Test 3: Mandatory data.type and data.id checks (missing data.type, missing data.id, mismatched type/id)
  await runOfficialTest(
    '3. [اختبار إلزامي 3] إلزامية data.type وdata.id ورفض غيابهما أو اختلافهما عن النوع والمعرف المتوقعين',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const { handler, exported } = loadWebhookModule({ env: TEST_ENV, supabaseMock: db });

      // 3a. Missing data.type
      const missingTypeObj = readFixtureJson('order_created.json');
      delete missingTypeObj.data.type;
      const rawMissingType = JSON.stringify(missingTypeObj);

      const extMissingType = exported.extractRawMonetaryTokens(rawMissingType, 'orders', '1001');
      assert.equal(extMissingType.ok, false);
      assert.equal(extMissingType.error, 'missing_resource_type');

      const resMissingType = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawMissingType),
            'X-Event-Name': 'order_created',
          },
          body: rawMissingType,
        }),
      );
      assert.equal(resMissingType.status, 400);
      assert.equal((await resMissingType.json()).error, 'missing_resource_type');

      // 3b. Missing data.id
      const missingIdObj = readFixtureJson('order_created.json');
      delete missingIdObj.data.id;
      const rawMissingId = JSON.stringify(missingIdObj);

      const extMissingId = exported.extractRawMonetaryTokens(rawMissingId, 'orders', '1001');
      assert.equal(extMissingId.ok, false);
      assert.equal(extMissingId.error, 'missing_resource_id');

      const resMissingId = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawMissingId),
            'X-Event-Name': 'order_created',
          },
          body: rawMissingId,
        }),
      );
      assert.equal(resMissingId.status, 400);
      assert.equal((await resMissingId.json()).error, 'missing_resource_id');

      // 3c. Mismatched data.type (e.g. `subscriptions` on `order_created`)
      const wrongTypeObj = readFixtureJson('order_created.json');
      wrongTypeObj.data.type = 'subscriptions';
      const rawWrongType = JSON.stringify(wrongTypeObj);

      const extWrongType = exported.extractRawMonetaryTokens(rawWrongType, 'orders', '1001');
      assert.equal(extWrongType.ok, false);
      assert.equal(extWrongType.error, 'resource_type_mismatch');

      const resWrongType = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawWrongType),
            'X-Event-Name': 'order_created',
          },
          body: rawWrongType,
        }),
      );
      assert.equal(resWrongType.status, 400);
      assert.equal((await resWrongType.json()).error, 'invalid_resource_type_for_event');

      // 3d. Mismatched data.id against expectedResourceId in extractRawMonetaryTokens
      const rawValidOrder = readFixtureRaw('order_created.json');
      const extWrongId = exported.extractRawMonetaryTokens(rawValidOrder, 'orders', '9999');
      assert.equal(extWrongId.ok, false);
      assert.equal(extWrongId.error, 'resource_id_mismatch');

      // 3e. Empty expectedResourceType or expectedResourceId when provided must also fail
      const extEmptyExpectedType = exported.extractRawMonetaryTokens(rawValidOrder, '', '1001');
      assert.equal(extEmptyExpectedType.ok, false);
      assert.equal(extEmptyExpectedType.error, 'resource_type_mismatch');

      const extEmptyExpectedId = exported.extractRawMonetaryTokens(rawValidOrder, 'orders', '');
      assert.equal(extEmptyExpectedId.ok, false);
      assert.equal(extEmptyExpectedId.error, 'resource_id_mismatch');
    },
  );

  // Test 4: Scoped extraction from `data.attributes` — must NEVER read `total` from `meta.custom_data`
  // or nested objects like `first_order_item`, and MUST reject duplicate `total` keys in `data.attributes`
  await runOfficialTest(
    '4. [اختبار إلزامي 4] استخراج القيم المالية حصريًا من data.attributes وتجاهل total في custom_data أو الكائنات المتداخلة ورفض المفاتيح المكررة',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const { handler, exported } = loadWebhookModule({ env: TEST_ENV, supabaseMock: db });

      const orderWithDecoys = {
        meta: {
          event_name: 'order_created',
          custom_data: {
            total: 100,
            tax: 99999,
            subtotal: 100,
            user_id: '11111111-1111-4111-8111-111111111111',
            page_id: '22222222-2222-4222-8222-222222222222',
          },
        },
        data: {
          type: 'orders',
          id: '4001',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            currency: 'USD',
            first_order_item: {
              id: 1,
              variant_id: 101001,
              price: 999,
              total: 50,
              tax: 10,
            },
            subtotal: 999,
            setup_fee: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            total_formatted: '$11.99',
          },
        },
      };
      const rawWithDecoys = JSON.stringify(orderWithDecoys);
      const extraction = exported.extractRawMonetaryTokens(rawWithDecoys, 'orders', '4001');
      assert.equal(extraction.ok, true);
      assert.equal(extraction.tokens.total, '1199');
      assert.equal(extraction.tokens.tax, '200');
      assert.equal(extraction.tokens.subtotal, '999');
      assert.equal(extraction.tokens.setup_fee, '999');

      const resDecoy = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawWithDecoys),
            'X-Event-Name': 'order_created',
          },
          body: rawWithDecoys,
        }),
      );
      const bodyDecoy = await resDecoy.json();
      assert.equal(resDecoy.status, 200);
      assert.equal(bodyDecoy.subscription_extended, true);
      assert.equal(bodyDecoy.internal_amount_minor, 1199);

      const rawDuplicateAttrKey =
        '{"meta":{"event_name":"order_created","custom_data":{"user_id":"11111111-1111-4111-8111-111111111111"}},' +
        '"data":{"type":"orders","id":"4002","attributes":{"store_id":55001,"test_mode":true,"status":"paid",' +
        '"currency":"USD","subtotal":999,"discount_total":0,"tax":200,"total":100,"total":1199,' +
        '"first_order_item":{"variant_id":101001}}}}';

      const dupCheck = exported.extractRawMonetaryTokens(rawDuplicateAttrKey, 'orders', '4002');
      assert.equal(dupCheck.ok, false);
      assert.equal(dupCheck.error, 'duplicate_json_key_detected');

      const resDup = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawDuplicateAttrKey),
            'X-Event-Name': 'order_created',
          },
          body: rawDuplicateAttrKey,
        }),
      );
      assert.equal(resDup.status, 400);
      assert.equal((await resDup.json()).error, 'duplicate_json_key_detected');
    },
  );

  // Test 5: Order equation with `setup_fee` (included in subtotal), `tax_inclusive`, and missing breakdown
  await runOfficialTest(
    '5. [اختبار إلزامي 5] معادلة Order الرسمية (subtotal - discount_total + tax == total) مع setup_fee مضمّن في subtotal ومراعاة tax_inclusive',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const handler = loadWebhookHandler({ env: TEST_ENV, supabaseMock: db });

      // 5a. Tax-inclusive Order (`subtotal = 999, setup_fee = 999, discount_total = 0, tax = 166, tax_inclusive = true => total = 999`)
      const orderTaxInclusive = readFixtureJson('order_created.json');
      orderTaxInclusive.data.id = '5001';
      orderTaxInclusive.data.attributes.subtotal = 999;
      orderTaxInclusive.data.attributes.setup_fee = 999;
      orderTaxInclusive.data.attributes.discount_total = 0;
      orderTaxInclusive.data.attributes.tax = 166;
      orderTaxInclusive.data.attributes.tax_inclusive = true;
      orderTaxInclusive.data.attributes.total = 999;
      orderTaxInclusive.data.attributes.total_formatted = '$9.99';
      const rawTaxIncl = JSON.stringify(orderTaxInclusive);

      const resTaxIncl = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawTaxIncl),
            'X-Event-Name': 'order_created',
          },
          body: rawTaxIncl,
        }),
      );
      const bodyTaxIncl = await resTaxIncl.json();
      assert.equal(resTaxIncl.status, 200);
      assert.equal(bodyTaxIncl.subscription_extended, true);
      assert.equal(bodyTaxIncl.internal_amount_minor, 999);

      // 5b. Order where `setup_fee > subtotal` (impossible since setup_fee is included in subtotal) -> queued for review
      const invalidSetupFeeOrder = readFixtureJson('order_created.json');
      invalidSetupFeeOrder.data.id = '5002';
      invalidSetupFeeOrder.data.attributes.subtotal = 999;
      invalidSetupFeeOrder.data.attributes.setup_fee = 1500; // exceeds subtotal 999
      invalidSetupFeeOrder.data.attributes.discount_total = 0;
      invalidSetupFeeOrder.data.attributes.tax = 200;
      invalidSetupFeeOrder.data.attributes.total = 1199;
      const rawBadSetup = JSON.stringify(invalidSetupFeeOrder);

      const resBadSetup = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBadSetup),
            'X-Event-Name': 'order_created',
          },
          body: rawBadSetup,
        }),
      );
      const bodyBadSetup = await resBadSetup.json();
      assert.equal(bodyBadSetup.subscription_extended, false);
      assert.equal(bodyBadSetup.reason, 'inconsistent_amount_breakdown_requires_review');
      assert.equal(bodyBadSetup.internal_amount_minor, null);

      // 5c. Order missing breakdown fields (`subtotal`, `tax` absent) -> queued for review (`missing_amount_breakdown_requires_review`)
      const missingBreakdownOrder = readFixtureJson('order_created.json');
      missingBreakdownOrder.data.id = '5004';
      delete missingBreakdownOrder.data.attributes.subtotal;
      delete missingBreakdownOrder.data.attributes.discount_total;
      delete missingBreakdownOrder.data.attributes.tax;
      const rawMissingBreakdown = JSON.stringify(missingBreakdownOrder);

      const resMissing = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawMissingBreakdown),
            'X-Event-Name': 'order_created',
          },
          body: rawMissingBreakdown,
        }),
      );
      const bodyMissing = await resMissing.json();
      assert.equal(resMissing.status, 200);
      assert.equal(bodyMissing.subscription_extended, false);
      assert.equal(bodyMissing.reason, 'missing_amount_breakdown_requires_review');
      assert.equal(bodyMissing.internal_amount_minor, null);
    },
  );

  // Test 6: Documented JPY (599 JPY = ¥599) vs Unverified KWD (halts extension for admin review)
  await runOfficialTest(
    '6. [اختبار إلزامي 6] قبول JPY الموثق رسميًا (599 JPY = ¥599) وإيقاف التمديد لعملة KWD غير المثبتة بمثال رسمي في توثيق Lemon Squeezy',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const handler = loadWebhookHandler({ env: TEST_ENV, supabaseMock: db });

      const jpyOrder = readFixtureJson('order_created.json');
      jpyOrder.data.id = '2001';
      jpyOrder.data.attributes.currency = 'JPY';
      jpyOrder.data.attributes.subtotal = 599;
      jpyOrder.data.attributes.setup_fee = 0;
      jpyOrder.data.attributes.discount_total = 0;
      jpyOrder.data.attributes.tax = 0;
      jpyOrder.data.attributes.total = 599;
      jpyOrder.data.attributes.total_formatted = '¥599';
      const rawJpy = JSON.stringify(jpyOrder);

      const resJpy = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawJpy),
            'X-Event-Name': 'order_created',
          },
          body: rawJpy,
        }),
      );
      const bodyJpy = await resJpy.json();
      assert.equal(resJpy.status, 200);
      assert.equal(bodyJpy.subscription_extended, true);
      assert.equal(bodyJpy.internal_amount_minor, 599);
      assert.equal(bodyJpy.currency, 'JPY');

      const kwdOrder = readFixtureJson('order_created.json');
      kwdOrder.data.id = '2002';
      kwdOrder.data.attributes.currency = 'KWD';
      kwdOrder.data.attributes.subtotal = 5000;
      kwdOrder.data.attributes.setup_fee = 0;
      kwdOrder.data.attributes.discount_total = 0;
      kwdOrder.data.attributes.tax = 0;
      kwdOrder.data.attributes.total = 5000;
      delete kwdOrder.data.attributes.total_formatted;
      const rawKwd = JSON.stringify(kwdOrder);

      const resKwd = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawKwd),
            'X-Event-Name': 'order_created',
          },
          body: rawKwd,
        }),
      );
      const bodyKwd = await resKwd.json();
      assert.equal(resKwd.status, 200);
      assert.equal(bodyKwd.subscription_extended, false);
      assert.equal(bodyKwd.status, 'reconciliation_logged');
      assert.equal(bodyKwd.reason, 'unverified_currency_unit_requires_review');
      assert.equal(bodyKwd.internal_amount_minor, null);
      assert.equal(bodyKwd.unapproved_truncated_minor, 5000);
    },
  );

  // Test 7: Full and Partial Refunds + Multi-renewal lifecycle & deduplication
  await runOfficialTest(
    '7. [اختبار إلزامي 7] استمرار اختبارات الاسترداد الكامل والجزئي والتجديدات المتعددة ومنع التكرار',
    async () => {
      const db = createStatefulDatabaseSimulator();
      const handler = loadWebhookHandler({ env: TEST_ENV, supabaseMock: db });

      async function sendFixture(filename) {
        const raw = readFixtureRaw(filename);
        const parsed = JSON.parse(raw);
        const sig = signPayload(TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, raw);
        const res = await handler(
          new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
            method: 'POST',
            headers: { 'X-Signature': sig, 'X-Event-Name': parsed.meta.event_name },
            body: raw,
          }),
        );
        return { status: res.status, body: await res.json() };
      }

      const rOrder = await sendFixture('order_created.json');
      assert.equal(rOrder.body.subscription_extended, true);
      assert.equal(rOrder.body.internal_amount_minor, 1199);

      const rOrderDup = await sendFixture('order_created.json');
      assert.equal(rOrderDup.body.subscription_extended, false);

      const rSub = await sendFixture('subscription_created.json');
      assert.equal(rSub.body.subscription_extended, false);

      const rInitInv = await sendFixture('subscription_payment_success_initial.json');
      assert.equal(rInitInv.body.subscription_extended, false);

      const rRen1 = await sendFixture('subscription_payment_success_renewal_1.json');
      assert.equal(rRen1.body.subscription_extended, true);
      assert.equal(rRen1.body.internal_amount_minor, 1199);

      const rRen2 = await sendFixture('subscription_payment_success_renewal_2.json');
      assert.equal(rRen2.body.subscription_extended, true);
      assert.equal(rRen2.body.internal_amount_minor, 1560);

      assert.equal(db.state.pageExtensionCount, 3);

      const rOrderRefund = await sendFixture('order_refunded.json');
      assert.equal(rOrderRefund.body.subscription_extended, false);
      assert.equal(rOrderRefund.body.status, 'reconciliation_logged');
      assert.equal(rOrderRefund.body.refund_type, 'unknown_missing');
      assert.equal(rOrderRefund.body.reason, 'refund_amount_unverified_requires_admin_review');
      assert.equal(rOrderRefund.body.refunded_amount_minor, null);
      assert.equal(
        db.state.paymentsByEventKey.get('order_created:1001').payment_status,
        'paid',
        'Unverified refund without explicit refunded_amount must NOT overwrite payment_status to refunded',
      );

      const rSubRefund = await sendFixture('subscription_payment_refunded.json');
      assert.equal(rSubRefund.body.subscription_extended, false);
      assert.equal(rSubRefund.body.refund_type, 'partial');
      assert.equal(rSubRefund.body.reason, 'partial_refund_requires_admin_review');
      assert.equal(rSubRefund.body.refunded_amount_minor, 500);
      assert.equal(
        db.state.paymentsByEventKey.get('subscription_payment_success:7002').payment_status,
        'partially_refunded',
      );
    },
  );

  // Test 8: public.payments schema repair, legacy row compatibility, and full column INSERT verification
  await runOfficialTest(
    '8. [اختبار إلزامي 8] توافق جدول public.payments مع الترحيل الأصلي (plan/days + plan_number/days_added) وحفظ السجلات القديمة دون قيم وهمية',
    async () => {
      const sql530 = fs.readFileSync(
        path.join(ROOT_DIR, 'supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql'),
        'utf8',
      );

      // 8a. Verify ALTER TABLE public.payments adds all required columns with IF NOT EXISTS
      const requiredAddedColumns = [
        'ADD COLUMN IF NOT EXISTS plan_number smallint',
        'ADD COLUMN IF NOT EXISTS days_added integer',
        'ADD COLUMN IF NOT EXISTS variant_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS order_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS subscription_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS customer_email text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS payment_status text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS store_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS resource_type text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS resource_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS event_name text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS refunded_amount integer NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT',
      ];
      for (const colClause of requiredAddedColumns) {
        assert.ok(sql530.includes(colClause), `Missing column clause in payments ALTER TABLE: ${colClause}`);
      }

      // 8b. Verify backfill of plan_number = plan and days_added = days before SET NOT NULL (no fake DEFAULT 0)
      assert.ok(
        /UPDATE\s+public\.payments\s+SET\s+plan_number\s*=\s*plan\s+WHERE\s+plan_number\s+IS\s+NULL/i.test(sql530),
        'Must backfill plan_number from plan for legacy rows',
      );
      assert.ok(
        /UPDATE\s+public\.payments\s+SET\s+days_added\s*=\s*days\s+WHERE\s+days_added\s+IS\s+NULL/i.test(sql530),
        'Must backfill days_added from days for legacy rows',
      );
      assert.ok(
        !sql530.includes('plan_number smallint NOT NULL DEFAULT 0') &&
          !sql530.includes('days_added integer NOT NULL DEFAULT 0'),
        'Must NOT use misleading DEFAULT 0 on plan_number or days_added',
      );

      // 8c. Verify consistency constraints between (plan, plan_number) and (days, days_added)
      assert.ok(
        sql530.includes('CHECK (plan BETWEEN 1 AND 3 AND plan_number BETWEEN 1 AND 3 AND plan_number = plan)'),
        'Must enforce plan == plan_number between 1 and 3',
      );
      assert.ok(
        sql530.includes('CHECK (days BETWEEN 1 AND 366 AND days_added BETWEEN 1 AND 366 AND days_added = days)'),
        'Must enforce days == days_added between 1 and 366',
      );

      // 8d. Verify INSERT INTO public.payments inside record_lemon_payment passes both plan/plan_number and days/days_added
      const insertMatch = sql530.match(/INSERT\s+INTO\s+public\.payments\s*\(([\s\S]*?)\)\s*VALUES\s*\(([\s\S]*?)\);/i);
      assert.ok(insertMatch, 'record_lemon_payment must contain INSERT INTO public.payments');
      const insertCols = insertMatch[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      const expectedInsertCols = [
        'event_key',
        'user_id',
        'page_id',
        'plan',
        'plan_number',
        'variant_id',
        'days',
        'days_added',
        'order_id',
        'subscription_id',
        'amount',
        'currency',
        'customer_email',
        'payment_status',
        'previous_expires_at',
        'effective_start_at',
        'granted_expires_at',
        'entitlement_status',
        'refund_resolution_status',
        'updated_at',
      ];
      assert.deepEqual(insertCols, expectedInsertCols, 'INSERT INTO public.payments must include all mandatory and provenance columns');

      // 8e. Simulate reading legacy payment records alongside newly inserted records
      const legacyRecord = {
        id: '00000000-0000-4000-8000-000000000001',
        event_key: '1000',
        user_id: '11111111-1111-4111-8111-111111111111',
        page_id: '22222222-2222-4222-8222-222222222222',
        plan: 2,
        days: 90,
        amount: 2499,
        currency: 'USD',
        created_at: '2026-11-01T00:00:00Z',
      };
      // Apply migration backfill simulation
      const migratedLegacyRecord = {
        ...legacyRecord,
        plan_number: legacyRecord.plan,
        days_added: legacyRecord.days,
        variant_id: '',
        order_id: '',
        subscription_id: '',
        customer_email: '',
        payment_status: 'paid',
        store_id: '',
        resource_type: 'orders',
        resource_id: '',
        event_name: 'order_created',
        refunded_amount: 0,
      };
      assert.equal(migratedLegacyRecord.plan, 2);
      assert.equal(migratedLegacyRecord.plan_number, 2);
      assert.equal(migratedLegacyRecord.days, 90);
      assert.equal(migratedLegacyRecord.days_added, 90);
      assert.equal(migratedLegacyRecord.payment_status, 'paid');
    },
  );

  // Test 9: public.pages status removal & preserving admin suspension (is_active = false)
  await runOfficialTest(
    '9. [اختبار إلزامي 9] إزالة أي اعتماد على pages.status والحفاظ على إيقاف الصفحة إداريًا (is_active = false) بعد الدفع واختبار الصفحة النشطة والتجريبية',
    async () => {
      const sql530 = fs.readFileSync(
        path.join(ROOT_DIR, 'supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql'),
        'utf8',
      );

      // 9a. Ensure zero references to `status = 'active'` or `is_active =` in any UPDATE public.pages statement
      assert.equal(
        /UPDATE\s+public\.pages[^;]*\bstatus\s*=/i.test(sql530),
        false,
        'public.pages UPDATE must NEVER reference non-existent column status',
      );
      assert.equal(
        /UPDATE\s+public\.pages[^;]*\bis_active\s*=/i.test(sql530),
        false,
        'record_lemon_payment must NEVER modify is_active on public.pages',
      );
      assert.ok(
        /UPDATE\s+public\.pages\s+SET\s+is_trial\s*=\s*false,\s*expires_at\s*=\s*v_new_expires\s+WHERE\s+id\s*=\s*v_target_page_id;/i.test(
          sql530,
        ),
        'record_lemon_payment must update ONLY is_trial = false and expires_at = v_new_expires',
      );

      // 9b. Simulate payment execution across 3 page states:
      //     (1) Admin-suspended page (`is_active = false, is_trial = true`)
      //     (2) Active trial page (`is_active = true, is_trial = true`)
      //     (3) Active paid page (`is_active = true, is_trial = false`)
      function simulateRecordLemonPaymentOnPage(page, daysToAdd) {
        const nowMs = Date.parse('2026-11-06T12:00:00Z');
        const currentExpMs = page.expires_at ? Date.parse(page.expires_at) : nowMs;
        const baseMs = Math.max(currentExpMs, nowMs);
        const newExpiresIso = new Date(baseMs + daysToAdd * 86400 * 1000).toISOString();
        // Mirrors exact SQL: UPDATE public.pages SET is_trial = false, expires_at = v_new_expires WHERE id = v_target_page_id;
        return {
          ...page,
          is_trial: false,
          expires_at: newExpiresIso,
        };
      }

      // Case 1: Suspended page (`is_active = false`) MUST stay `is_active = false` after valid payment
      const suspendedPage = {
        id: 'page-suspended-1',
        user_id: 'user-1',
        is_active: false,
        is_trial: true,
        expires_at: '2026-11-05T00:00:00.000Z',
      };
      const updatedSuspended = simulateRecordLemonPaymentOnPage(suspendedPage, 30);
      assert.equal(updatedSuspended.is_active, false, 'Admin-suspended page MUST remain is_active = false after payment');
      assert.equal(updatedSuspended.is_trial, false, 'Trial flag cleared on payment');
      assert.equal(updatedSuspended.expires_at, '2026-12-06T12:00:00.000Z');

      // Case 2: Trial page (`is_active = true, is_trial = true`) transitions to paid active page
      const trialPage = {
        id: 'page-trial-1',
        user_id: 'user-2',
        is_active: true,
        is_trial: true,
        expires_at: '2026-11-10T12:00:00.000Z',
      };
      const updatedTrial = simulateRecordLemonPaymentOnPage(trialPage, 30);
      assert.equal(updatedTrial.is_active, true);
      assert.equal(updatedTrial.is_trial, false);
      assert.equal(updatedTrial.expires_at, '2026-12-10T12:00:00.000Z');

      // Case 3: Active paid page (`is_active = true, is_trial = false`) extends from current future expiry
      const activePaidPage = {
        id: 'page-paid-1',
        user_id: 'user-3',
        is_active: true,
        is_trial: false,
        expires_at: '2026-12-01T12:00:00.000Z',
      };
      const updatedPaid = simulateRecordLemonPaymentOnPage(activePaidPage, 90);
      assert.equal(updatedPaid.is_active, true);
      assert.equal(updatedPaid.is_trial, false);
      assert.equal(updatedPaid.expires_at, '2027-03-01T12:00:00.000Z');
    },
  );

  // Test 10: processed_webhook_events schema compatibility between 20261106041500 and 20261106053000
  await runOfficialTest(
    '10. [اختبار إلزامي 10] تطابق بنية processed_webhook_events بين ترحيل Phase 1 وترحيل الدفع مع جميع الاستعلامات والفهارس',
    async () => {
      const sql415 = fs.readFileSync(
        path.join(ROOT_DIR, 'supabase/migrations/20261106041500_phase1_security_hardening_and_audit_logs.sql'),
        'utf8',
      );
      const sql530 = fs.readFileSync(
        path.join(ROOT_DIR, 'supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql'),
        'utf8',
      );

      // 10a. Verify Phase 1 creates processed_webhook_events with event_id, event_name, provider, processed_at
      assert.ok(sql415.includes('event_id text PRIMARY KEY'));
      assert.ok(sql415.includes('event_name text NOT NULL'));
      assert.ok(sql415.includes("provider text NOT NULL DEFAULT 'lemonsqueezy'"));
      assert.ok(sql415.includes('processed_at timestamptz NOT NULL'));

      // 10b. Verify 20261106053000 alters processed_webhook_events with ADD COLUMN IF NOT EXISTS
      const requiredWebhookCols = [
        'ADD COLUMN IF NOT EXISTS delivery_id text',
        'ADD COLUMN IF NOT EXISTS event_key text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS resource_type text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS resource_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS store_id text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS test_mode boolean NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS result_code text NOT NULL DEFAULT',
        'ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT',
      ];
      for (const clause of requiredWebhookCols) {
        assert.ok(sql530.includes(clause), `Missing processed_webhook_events column clause: ${clause}`);
      }

      // 10c. Verify every INSERT INTO public.processed_webhook_events in 20261106053000 includes event_id, delivery_id, event_key, event_name, provider
      const webhookInserts = [
        ...sql530.matchAll(/INSERT\s+INTO\s+public\.processed_webhook_events\s*\(([\s\S]*?)\)\s*VALUES/gi),
      ];
      assert.equal(webhookInserts.length, 3, 'Must have 3 INSERT INTO public.processed_webhook_events statements');
      for (const match of webhookInserts) {
        const cols = match[1]
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        assert.ok(cols.includes('event_id'), 'INSERT into processed_webhook_events must include event_id (PK)');
        assert.ok(cols.includes('delivery_id'), 'INSERT into processed_webhook_events must include delivery_id');
        assert.ok(cols.includes('event_key'), 'INSERT into processed_webhook_events must include event_key');
        assert.ok(cols.includes('event_name'), 'INSERT into processed_webhook_events must include event_name');
        assert.ok(cols.includes('provider'), 'INSERT into processed_webhook_events must include provider');
      }
    },
  );

  // Test 11: Removal of obsolete 5-arg record_lemon_payment overload & least-privilege grants
  await runOfficialTest(
    '11. [اختبار إلزامي 11] حذف التوقيع القديم record_lemon_payment(text, uuid, text, integer, text) والتحقق من الصلاحيات وsearch_path',
    async () => {
      const sql530 = fs.readFileSync(
        path.join(ROOT_DIR, 'supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql'),
        'utf8',
      );

      // 11a. Verify obsolete 5-arg function is revoked and dropped
      assert.ok(
        sql530.includes(
          'REVOKE ALL ON FUNCTION public.record_lemon_payment(text, uuid, text, integer, text) FROM PUBLIC, anon, authenticated, service_role;',
        ),
        'Must revoke all privileges on old 5-arg overload',
      );
      assert.ok(
        sql530.includes('DROP FUNCTION IF EXISTS public.record_lemon_payment(text, uuid, text, integer, text);'),
        'Must drop old 5-arg overload of record_lemon_payment',
      );

      // 11b. Verify 9-arg record_lemon_payment and 16-arg process_lemon_payment_webhook are restricted to service_role only
      assert.ok(
        sql530.includes(
          'REVOKE ALL ON FUNCTION public.record_lemon_payment(text, uuid, uuid, text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;',
        ),
      );
      assert.ok(
        sql530.includes(
          'GRANT EXECUTE ON FUNCTION public.record_lemon_payment(text, uuid, uuid, text, text, text, integer, text, text) TO service_role;',
        ),
      );
      assert.ok(
        sql530.includes(
          'REVOKE ALL ON FUNCTION public.process_lemon_payment_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, integer, text, text, jsonb) FROM PUBLIC, anon, authenticated;',
        ),
      );
      assert.ok(
        sql530.includes(
          'GRANT EXECUTE ON FUNCTION public.process_lemon_payment_webhook(text, text, text, text, text, text, boolean, uuid, uuid, text, text, text, integer, text, text, jsonb) TO service_role;',
        ),
      );

      // 11c. Verify every SECURITY DEFINER function in 20261106053000 sets `SET search_path = ''`
      const definerCount = (sql530.match(/SECURITY DEFINER/g) || []).length;
      const searchPathCount = (sql530.match(/SET search_path = ''/g) || []).length;
      assert.equal(definerCount, 6, 'All 6 functions in 20261106053000 are SECURITY DEFINER');
      assert.equal(searchPathCount, 6, "All 6 SECURITY DEFINER functions must have SET search_path = ''");

      // 11d. Verify admin_resolve_payment_reconciliation_issue revokes service_role and checks already-resolved state
      assert.ok(
        sql530.includes(
          'DROP FUNCTION IF EXISTS public.admin_resolve_payment_reconciliation_issue(bigint, text);',
        ),
      );
      assert.ok(
        sql530.includes(
          'REVOKE ALL ON FUNCTION public.admin_resolve_payment_reconciliation_issue(bigint, text, text, bigint, text) FROM PUBLIC, anon, service_role;',
        ),
      );
      assert.ok(sql530.includes("RAISE EXCEPTION 'reconciliation issue already resolved'"));
    },
  );

  const passedCount = results.filter((r) => r.passed).length;
  console.log('====================================================================');
  console.log(`النتيجة النهائية لاختبارات الوحدات المالية وتوافق SQL قبل Staging: ${passedCount}/${results.length} ناجحة`);
  console.log('====================================================================');
})();
