/**
 * ============================================================================
 * PAG ADS — COMPREHENSIVE MOCKED UNIT TEST SUITE (اختبارات وحدات محاكاة شاملة)
 * ============================================================================
 * IMPORTANT NOTICE:
 * - All 39 tests in this file use controlled MOCKED API responses and an
 *   in-memory mocked Supabase client.
 * - They transpile and execute the actual Edge Function handlers defined in:
 *     1. supabase/functions/lemon-checkout/index.ts
 *     2. supabase/functions/lemon-webhook/index.ts
 * - These tests DO NOT connect to Lemon Squeezy servers or execute real payments.
 * ============================================================================
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const ROOT_DIR = process.cwd();

function signPayload(secret, rawString) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(rawString, 'utf8')).digest('hex');
}

function loadEdgeFunctionHandler(relativePath, { env = {}, supabaseMock, fetchMock }) {
  const fullPath = path.join(ROOT_DIR, relativePath);
  const rawSource = fs
    .readFileSync(fullPath, 'utf8')
    .replace(/import\s+\{\s*createClient\s*\}\s+from\s+["']npm:@supabase\/supabase-js@2["'];?/g, '')
    .replace(/export\s+\{[\s\S]*?\};?\s*$/m, '');

  const transpiled = stripTypeScriptTypes(rawSource);

  let capturedHandler = null;

  const sandbox = {
    exports: {},
    module: { exports: {} },
    console: {
      log: () => {},
      error: () => {},
      warn: () => {},
    },
    Response,
    Request,
    Headers,
    URL,
    TextEncoder,
    TextDecoder,
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    fetch: fetchMock || (async () => new Response('{}', { status: 500 })),
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

  vm.createContext(sandbox);
  vm.runInContext(transpiled, sandbox, { filename: relativePath });

  if (typeof capturedHandler !== 'function') {
    throw new Error(`Failed to capture Deno.serve handler from ${relativePath}`);
  }
  return { handler: capturedHandler, sandbox };
}

function createMockSupabase({
  user = { id: '11111111-1111-4111-8111-111111111111', email: 'customer@example.com' },
  isAdmin = false,
  pricingSettings = null,
  pages = [],
  upsertError = null,
  rpcHandler = async () => ({ data: 'ok', error: null }),
} = {}) {
  const reconciliationLogs = [];
  const splitUpsertCalls = [];
  return {
    reconciliationLogs,
    splitUpsertCalls,
    auth: {
      async getUser(token) {
        if (token !== 'valid-jwt-token' || !user) {
          return { data: { user: null }, error: { message: 'invalid_token' } };
        }
        return { data: { user }, error: null };
      },
    },
    from(table) {
      if (table === 'admin_users') {
        return {
          select() {
            return {
              eq(_col, val) {
                return {
                  async maybeSingle() {
                    if (isAdmin && user && val === user.id) {
                      return { data: { user_id: user.id }, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
        };
      }
      if (table === 'pricing_settings') {
        return {
          select() {
            return {
              eq() {
                return {
                  async maybeSingle() {
                    return { data: pricingSettings, error: null };
                  },
                };
              },
            };
          },
          update() {
            return {
              async eq() {
                return { data: null, error: null };
              },
            };
          },
        };
      }
      if (table === 'pages') {
        return {
          select() {
            return {
              async eq(_col, val) {
                return { data: pages.filter((p) => p.user_id === val), error: null };
              },
            };
          },
        };
      }
      if (table === 'payment_reconciliation_issues') {
        return {
          async upsert(record) {
            splitUpsertCalls.push(record);
            if (upsertError) {
              return { data: null, error: upsertError };
            }
            reconciliationLogs.push(record);
            return { data: record, error: null };
          },
        };
      }
      throw new Error(`Unexpected table access in mock: ${table}`);
    },
    async rpc(fnName, args) {
      const res = await rpcHandler(fnName, args);
      if (!res?.error && fnName === 'process_lemon_lifecycle_webhook' && args?.p_reason) {
        reconciliationLogs.push({
          event_key: args.p_event_key,
          delivery_id: args.p_delivery_id,
          event_name: args.p_event_name,
          reason: args.p_reason,
          failure_reason: args.p_reason,
          refund_type: args.p_refund_type,
          refunded_amount: args.p_refunded_amount,
          raw_refunded_amount: args.p_raw_refunded_amount,
          amount: args.p_amount,
          total_amount: args.p_amount,
          currency: args.p_currency,
          raw_meta: args.p_raw_meta,
        });
      }
      return res;
    },
  };
}

const VALID_USER_ID = '11111111-1111-4111-8111-111111111111';
const VALID_PAGE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_PAGE_ID = '99999999-9999-4999-8999-999999999999';

const DEFAULT_SETTINGS = {
  id: 'global',
  payment_provider_enabled: true,
  payment_mode: 'test',
  payment_provider_mode: 'test',
  store_id: '55001',
  lemon_test_store_id: '55001',
  lemon_store_id: '88001',
  plan1_test_variant_id: '101001',
  plan2_test_variant_id: '101002',
  plan3_test_variant_id: '101003',
  plan1_variant_id: '202001',
  plan2_variant_id: '202002',
  plan3_variant_id: '202003',
  plan1_new_price: '$11.99 USD',
  plan2_new_price: '$29.99 USD',
  plan3_new_price: '$99.99 USD',
  plan1_days: 30,
  plan2_days: 90,
  plan3_days: 365,
};

const BASE_TEST_ENV = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'mock-service-role-key',
  LEMONSQUEEZY_ENABLED: 'true',
  LEMONSQUEEZY_MODE: 'test',
  LEMONSQUEEZY_TEST_API_KEY: 'mock-test-api-key',
  LEMONSQUEEZY_TEST_STORE_ID: '55001',
  LEMONSQUEEZY_TEST_WEBHOOK_SECRET: 'mock-test-webhook-secret-12345',
  LEMONSQUEEZY_LIVE_API_KEY: 'mock-live-api-key',
  LEMONSQUEEZY_LIVE_STORE_ID: '88001',
  LEMONSQUEEZY_LIVE_WEBHOOK_SECRET: 'mock-live-webhook-secret-99999',
};

const results = [];

async function runTest(category, name, fn) {
  const fullName = `[${category}] ${name}`;
  try {
    await fn();
    results.push({ category, name, passed: true });
    console.log(`✅ [MOCKED PASS] ${fullName}`);
  } catch (err) {
    results.push({ category, name, passed: false, error: err.message });
    console.error(`❌ [MOCKED FAIL] ${fullName}:`, err.message);
    process.exitCode = 1;
  }
}

await (async () => {
  console.log('====================================================================');
  console.log('بدء تشغيل اختبارات المحاكاة الشاملة (39 Mocked Unit Tests — No Live API)');
  console.log('====================================================================');

  // ============================================================================
  // CATEGORY A: CHECKOUT TESTS (6 TESTS)
  // ============================================================================
  await runTest('A. Checkout', 'A1. Disabled mode (رفض الدفع عند إيقاف المزود دون أي اتصال خارجي)', async () => {
    let externalFetchCalled = false;
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: { ...BASE_TEST_ENV, LEMONSQUEEZY_ENABLED: 'false', LEMONSQUEEZY_MODE: 'disabled' },
      supabaseMock: createMockSupabase({ pricingSettings: DEFAULT_SETTINGS }),
      fetchMock: async () => {
        externalFetchCalled = true;
        return new Response('{}', { status: 200 });
      },
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1 }),
      }),
    );
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error, 'provider_disabled');
    assert.equal(externalFetchCalled, false);
  });

  await runTest('A. Checkout', 'A2. Missing API key (رفض الدفع عند غياب مفتاح API للوضع الفعّال)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: { ...BASE_TEST_ENV, LEMONSQUEEZY_TEST_API_KEY: '', LEMONSQUEEZY_API_KEY: '' },
      supabaseMock: createMockSupabase({ pricingSettings: DEFAULT_SETTINGS }),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1 }),
      }),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'missing_api_key');
  });

  await runTest('A. Checkout', 'A3. Missing Store ID (رفض الدفع عند غياب معرف المتجر)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: { ...BASE_TEST_ENV, LEMONSQUEEZY_TEST_STORE_ID: '', LEMONSQUEEZY_STORE_ID: '' },
      supabaseMock: createMockSupabase({
        pricingSettings: { ...DEFAULT_SETTINGS, store_id: '', lemon_test_store_id: '' },
      }),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1 }),
      }),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'missing_store_id');
  });

  await runTest('A. Checkout', 'A4. Missing Variant ID (رفض الدفع عند غياب معرف الباقة للوضع الفعّال)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({
        pricingSettings: { ...DEFAULT_SETTINGS, plan1_test_variant_id: '' },
        pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
      }),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1 }),
      }),
    );
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'missing_variant_id');
  });

  await runTest('A. Checkout', 'A5. Invalid plan (رفض رقم باقة خارج النطاق 1..3)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({ pricingSettings: DEFAULT_SETTINGS }),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 99 }),
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_plan');
  });

  await runTest('A. Checkout', 'A6. Valid Test Mode checkout request ($11.99 USD -> 1199 cents)', async () => {
    let sentPayload = null;
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({
        pricingSettings: DEFAULT_SETTINGS,
        pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
      }),
      fetchMock: async (_url, opts) => {
        sentPayload = JSON.parse(opts.body);
        return new Response(
          JSON.stringify({
            data: { attributes: { url: 'https://pagads.lemonsqueezy.com/checkout/buy/test-session-1' } },
          }),
          { status: 200 },
        );
      },
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1, origin: 'https://sbrzxvujrylyohmybddj.supabase.co' }),
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.url, 'https://pagads.lemonsqueezy.com/checkout/buy/test-session-1');
    assert.equal(body.mode, 'test');
    assert.equal(sentPayload.data.attributes.custom_price, 1199);
    assert.equal(sentPayload.data.attributes.test_mode, true);
    assert.equal(sentPayload.data.attributes.checkout_data.custom.user_id, VALID_USER_ID);
    assert.equal(sentPayload.data.attributes.checkout_data.custom.page_id, VALID_PAGE_ID);
    assert.equal(sentPayload.data.relationships.variant.data.id, '101001');
  });

  // ============================================================================
  // CATEGORY B: WEBHOOK TESTS (9 TESTS)
  // ============================================================================
  await runTest('B. Webhook', 'B1. Missing signature (رفض طلب Webhook بدون ترويسة X-Signature)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        body: '{}',
      }),
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'missing_signature');
  });

  await runTest('B. Webhook', 'B2. Invalid signature (رفض طلب Webhook بتوقيع HMAC غير مطابق)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({ meta: { event_name: 'order_created' }, data: { attributes: { test_mode: true } } });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': signPayload('wrong-key', rawBody) },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'invalid_signature');
  });

  await runTest('B. Webhook', 'B3. Empty body (رفض جسم الطلب الفارغ)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': 'abcd1234' },
        body: '',
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'empty_body');
  });

  await runTest('B. Webhook', 'B4. Invalid JSON (رفض حمولة غير صالحة كـ JSON حتى لو وُقعت)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = '{invalid-json-payload';
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_json');
  });

  await runTest('B. Webhook', 'B5. Event header mismatch (رفض تعارض X-Event-Name مع meta.event_name)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { type: 'orders', id: '100', attributes: { store_id: 55001, test_mode: true } },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_refunded' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'event_name_header_mismatch');
  });

  await runTest('B. Webhook', 'B6. Store ID mismatch (رفض إشعار صادر من متجر مختلف عن المتجر المعتمد)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { type: 'orders', id: '101', attributes: { store_id: 99999, test_mode: true } },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'store_id_mismatch');
  });

  await runTest('B. Webhook', 'B7. Test webhook in Live mode (رفض إشعار اختباري عندما يكون النظام في الوضع المباشر)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: { ...BASE_TEST_ENV, LEMONSQUEEZY_MODE: 'live' },
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { type: 'orders', id: '102', attributes: { store_id: 88001, test_mode: true } },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_LIVE_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'test_webhook_in_live_mode');
  });

  await runTest('B. Webhook', 'B8. Live webhook in Test mode (رفض إشعار مباشر عندما يكون النظام في الوضع الاختباري)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created' },
      data: { type: 'orders', id: '103', attributes: { store_id: 55001, test_mode: false } },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'live_webhook_in_test_mode');
  });

  await runTest(
    'B. Webhook',
    'B9. Dual test_mode inspection (اعتماد data.attributes.test_mode ورفض التعارض أو الغياب)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase(),
      });
      const conflictingBody = JSON.stringify({
        meta: { event_name: 'order_created', test_mode: false },
        data: { type: 'orders', id: '104', attributes: { store_id: 55001, test_mode: true } },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, conflictingBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: conflictingBody,
        }),
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'malformed_test_mode_flag');
      assert.equal(body.reason, 'conflicting_test_mode_flags');
    },
  );

  // ============================================================================
  // CATEGORY C: FINANCIAL AMOUNT & CURRENCY TESTS (7 TESTS)
  // ============================================================================
  await runTest('C. Financials', 'C1. 1199 USD with "$11.99" (يبقى 1199 سنت ولا يضرب في 100 إلى 119900)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
      data: {
        type: 'orders',
        id: '200',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          subtotal: 999,
          discount_total: 0,
          tax: 200,
          total: 1199,
          total_formatted: '$11.99',
          currency: 'USD',
          first_order_item: { variant_id: 101001 },
        },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscription_extended, true);
    assert.equal(body.internal_amount_minor, 1199);
    assert.notEqual(body.internal_amount_minor, 119900);
  });

  await runTest(
    'C. Financials',
    'C2. Unverified KWD currency in webhook (إيقاف التمديد التلقائي لـ KWD لعدم وجود مثال رسمي موثق في Lemon Squeezy)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase(),
      });
      const rawBody = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
        data: {
          type: 'orders',
          id: '2005',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            total: 5000,
            currency: 'KWD',
            first_order_item: { variant_id: 101001 },
          },
        },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: rawBody,
        }),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.subscription_extended, false);
      assert.equal(body.status, 'reconciliation_logged');
      assert.equal(body.reason, 'unverified_currency_unit_requires_review');
    },
  );

  await runTest('C. Financials', 'C3. JPY (عملة موثقة بدون كسور: 599 JPY مع "¥599" = 599 ين)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
      data: {
        type: 'orders',
        id: '2006',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          subtotal: 599,
          discount_total: 0,
          tax: 0,
          total: 599,
          total_formatted: '¥599',
          currency: 'JPY',
          first_order_item: { variant_id: 101001 },
        },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscription_extended, true);
    assert.equal(body.internal_amount_minor, 599);
  });

  await runTest('C. Financials', 'C4. Negative amount (رفض المبالغ السالبة في Webhook)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
      data: {
        type: 'orders',
        id: '201',
        attributes: { store_id: 55001, test_mode: true, status: 'paid', total: -1199, currency: 'USD' },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_payment_amount');
  });

  await runTest('C. Financials', 'C5. Zero amount (رفض المبلغ الصفري 0 لتمديد الباقات المدفوعة)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
      data: {
        type: 'orders',
        id: '202',
        attributes: { store_id: 55001, test_mode: true, status: 'paid', total: 0, currency: 'USD' },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_payment_amount');
  });

  await runTest(
    'C. Financials',
    'C6. 1859.76 EUR with "€18.59" (عدم إنشاء دفعة معتمدة بمبلغ مبتور 1859 وعدم تمديد الاشتراك)',
    async () => {
      let paymentRpcCalled = false;
      const supabaseMock = createMockSupabase({
        rpcHandler: async (fnName) => {
          if (fnName === 'process_lemon_payment_webhook') {
            paymentRpcCalled = true;
          }
          return { data: 'ok', error: null };
        },
      });
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock,
      });

      const fractionalCentsBody = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
        data: {
          type: 'orders',
          id: '2031',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            subtotal: 1499.985,
            discount_total: 0,
            tax: 359.775,
            total: 1859.76,
            total_formatted: '€18.59',
            currency: 'EUR',
            first_order_item: { variant_id: 101001 },
          },
        },
      });
      const sig1 = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, fractionalCentsBody);
      const res1 = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig1, 'X-Event-Name': 'order_created' },
          body: fractionalCentsBody,
        }),
      );
      assert.equal(res1.status, 200);
      const body1 = await res1.json();
      assert.equal(body1.subscription_extended, false);
      assert.equal(body1.status, 'reconciliation_logged');
      assert.equal(body1.reason, 'fractional_minor_unit_requires_review');
      assert.equal(body1.internal_amount_minor, null, 'Must NOT return 1859 as approved internal_amount_minor');
      assert.equal(body1.unapproved_truncated_minor, 1859);
      assert.equal(body1.provider_total_raw, '1859.76');
      assert.equal(paymentRpcCalled, false, 'process_lemon_payment_webhook must NEVER be called for fractional cents');
      assert.equal(supabaseMock.reconciliationLogs.length, 1);
      assert.equal(supabaseMock.reconciliationLogs[0].amount, 0, 'Reconciliation amount column must be 0, not 1859');
    },
  );

  await runTest('C. Financials', 'C7. Invalid currency (رفض رمز عملة غير مطابق لمعيار ISO 4217)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
      data: {
        type: 'orders',
        id: '204',
        attributes: { store_id: 55001, test_mode: true, status: 'paid', total: 1199, currency: 'BAD_CURR' },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, 'invalid_currency_code');
  });

  await runTest(
    'C. Financials',
    'C8. Scoped data.attributes extraction & duplicate key rejection (تجاهل total في custom_data ورفض تكرار المفاتيح)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase(),
      });

      // Decoy total inside custom_data and inside first_order_item
      const decoyBody = JSON.stringify({
        meta: {
          event_name: 'order_created',
          custom_data: { total: 50, tax: 9999, user_id: VALID_USER_ID, page_id: VALID_PAGE_ID },
        },
        data: {
          type: 'orders',
          id: '2081',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            first_order_item: { variant_id: 101001, total: 75, tax: 888 },
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            total_formatted: '$11.99',
            currency: 'USD',
          },
        },
      });
      const resDecoy = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, decoyBody),
            'X-Event-Name': 'order_created',
          },
          body: decoyBody,
        }),
      );
      assert.equal(resDecoy.status, 200);
      const bodyDecoy = await resDecoy.json();
      assert.equal(bodyDecoy.subscription_extended, true);
      assert.equal(bodyDecoy.internal_amount_minor, 1199);

      // Duplicate total key inside data.attributes -> rejected with 400
      const duplicateKeyRaw =
        '{"meta":{"event_name":"order_created","custom_data":{"user_id":"' +
        VALID_USER_ID +
        '"}},"data":{"type":"orders","id":"2082","attributes":{"store_id":55001,"test_mode":true,"status":"paid",' +
        '"subtotal":999,"discount_total":0,"tax":200,"total":100,"total":1199,"currency":"USD"}}}';
      const resDup = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, duplicateKeyRaw),
            'X-Event-Name': 'order_created',
          },
          body: duplicateKeyRaw,
        }),
      );
      assert.equal(resDup.status, 400);
      assert.equal((await resDup.json()).error, 'duplicate_json_key_detected');
    },
  );

  await runTest(
    'C. Financials',
    'C9. Official Order setup_fee example & mandatory data.type/data.id (المثال الرسمي 999 + setup_fee 999 + tax 200 = 1199 وإلزامية data.type وdata.id)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase(),
      });

      // Official Lemon Squeezy Order Object example: subtotal=999, setup_fee=999, discount_total=0, tax=200 => total=1199
      const validWithSetupFee = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID } },
        data: {
          type: 'orders',
          id: '2091',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            subtotal: 999,
            setup_fee: 999,
            discount_total: 0,
            tax: 200,
            tax_inclusive: false,
            total: 1199,
            total_formatted: '$11.99',
            currency: 'USD',
            first_order_item: { variant_id: 101001 },
          },
        },
      });
      const resValid = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, validWithSetupFee),
            'X-Event-Name': 'order_created',
          },
          body: validWithSetupFee,
        }),
      );
      const bodyValid = await resValid.json();
      assert.equal(resValid.status, 200);
      assert.equal(bodyValid.subscription_extended, true);
      assert.equal(bodyValid.internal_amount_minor, 1199);

      // Missing data.type -> rejected with 400
      const missingTypeBody = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
        data: {
          id: '2092',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            currency: 'USD',
          },
        },
      });
      const resMissingType = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, missingTypeBody),
            'X-Event-Name': 'order_created',
          },
          body: missingTypeBody,
        }),
      );
      assert.equal(resMissingType.status, 400);
      assert.equal((await resMissingType.json()).error, 'missing_resource_type');

      // Missing data.id -> rejected with 400
      const missingIdBody = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
        data: {
          type: 'orders',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            currency: 'USD',
          },
        },
      });
      const resMissingId = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, missingIdBody),
            'X-Event-Name': 'order_created',
          },
          body: missingIdBody,
        }),
      );
      assert.equal(resMissingId.status, 400);
      assert.equal((await resMissingId.json()).error, 'missing_resource_id');
    },
  );

  // ============================================================================
  // CATEGORY D: SUBSCRIPTION & REFUND LIFECYCLE TESTS (9 TESTS)
  // ============================================================================
  await runTest('D. Lifecycle', 'D1. Valid paid order (تمديد الاشتراك مرة واحدة عند order_created بعملة USD موثقة)', async () => {
    let rpcArgs = null;
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({
        rpcHandler: async (fn, args) => {
          if (fn === 'process_lemon_payment_webhook') rpcArgs = args;
          return { data: 'ok', error: null };
        },
      }),
    });
    const rawBody = JSON.stringify({
      meta: {
        event_name: 'order_created',
        custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID },
      },
      data: {
        type: 'orders',
        id: '301',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          refunded: false,
          subtotal: 999,
          discount_total: 0,
          tax: 200,
          total: 1199,
          total_formatted: '$11.99',
          currency: 'USD',
          first_order_item: { variant_id: 101001 },
        },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.subscription_extended, true);
    assert.equal(rpcArgs.p_amount, 1199);
    assert.equal(rpcArgs.p_variant_id, '101001');
  });

  await runTest('D. Lifecycle', 'D2. Duplicate webhook (منع التمديد المزدوج عند استلام نفس الإشعار مرتين)', async () => {
    const seen = new Set();
    let extensions = 0;
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({
        rpcHandler: async (_fn, args) => {
          if (seen.has(args.p_delivery_id)) return { data: 'duplicate_delivery', error: null };
          seen.add(args.p_delivery_id);
          extensions += 1;
          return { data: 'ok', error: null };
        },
      }),
    });
    const rawBody = JSON.stringify({
      meta: {
        event_name: 'order_created',
        custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID },
      },
      data: {
        type: 'orders',
        id: '302',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          subtotal: 999,
          discount_total: 0,
          tax: 200,
          total: 1199,
          currency: 'USD',
          first_order_item: { variant_id: 101001 },
        },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const r1 = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    const r2 = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal((await r1.json()).subscription_extended, true);
    assert.equal((await r2.json()).subscription_extended, false);
    assert.equal(extensions, 1);
  });

  await runTest(
    'D. Lifecycle',
    'D3. Related initial events (order_created + subscription_created + initial subscription_payment_success يمدد مرة واحدة فقط)',
    async () => {
      let extensions = 0;
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          rpcHandler: async (fn) => {
            if (fn === 'process_lemon_payment_webhook') extensions += 1;
            return { data: 'ok', error: null };
          },
        }),
      });

      const events = [
        {
          name: 'order_created',
          body: {
            meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
            data: {
              type: 'orders',
              id: '303',
              attributes: {
                store_id: 55001,
                test_mode: true,
                status: 'paid',
                subtotal: 999,
                discount_total: 0,
                tax: 200,
                total: 1199,
                currency: 'USD',
                first_order_item: { variant_id: 101001 },
              },
            },
          },
        },
        {
          name: 'subscription_created',
          body: {
            meta: { event_name: 'subscription_created', custom_data: { user_id: VALID_USER_ID } },
            data: {
              type: 'subscriptions',
              id: '403',
              attributes: { store_id: 55001, test_mode: true, status: 'active', variant_id: 101001 },
            },
          },
        },
        {
          name: 'subscription_payment_success',
          body: {
            meta: {
              event_name: 'subscription_payment_success',
              custom_data: { user_id: VALID_USER_ID },
            },
            data: {
              type: 'subscription-invoices',
              id: '503',
              attributes: {
                store_id: 55001,
                test_mode: true,
                status: 'paid',
                billing_reason: 'initial',
                subtotal: 999,
                discount_total: 0,
                tax: 200,
                total: 1199,
                currency: 'USD',
                variant_id: 101001,
              },
            },
          },
        },
      ];

      for (const item of events) {
        const raw = JSON.stringify(item.body);
        const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, raw);
        const res = await handler(
          new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
            method: 'POST',
            headers: { 'X-Signature': sig, 'X-Event-Name': item.name },
            body: raw,
          }),
        );
        assert.equal(res.status, 200);
      }

      assert.equal(extensions, 1, 'Initial purchase across 3 events must extend subscription exactly once');
    },
  );

  await runTest(
    'D. Lifecycle',
    'D4. Subscription renewal (تمديد الاشتراك عند subscription_payment_success مع billing_reason=renewal)',
    async () => {
      let extensions = 0;
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          rpcHandler: async (fn) => {
            if (fn === 'process_lemon_payment_webhook') extensions += 1;
            return { data: 'ok', error: null };
          },
        }),
      });
      const rawBody = JSON.stringify({
        meta: {
          event_name: 'subscription_payment_success',
          custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID },
        },
        data: {
          type: 'subscription-invoices',
          id: '304',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            billing_reason: 'renewal',
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            currency: 'USD',
            variant_id: 101001,
          },
        },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'subscription_payment_success' },
          body: rawBody,
        }),
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).subscription_extended, true);
      assert.equal(extensions, 1);
    },
  );

  await runTest('D. Lifecycle', 'D5. Failed payment (عدم التمديد عند subscription_payment_failed)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'subscription_payment_failed', custom_data: { user_id: VALID_USER_ID } },
      data: { type: 'subscription-invoices', id: '305', attributes: { store_id: 55001, test_mode: true } },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'subscription_payment_failed' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).subscription_extended, false);
  });

  await runTest('D. Lifecycle', 'D6. Recovered payment (عدم التمديد المزدوج عند subscription_payment_recovered)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    const rawBody = JSON.stringify({
      meta: { event_name: 'subscription_payment_recovered', custom_data: { user_id: VALID_USER_ID } },
      data: { type: 'subscription-invoices', id: '306', attributes: { store_id: 55001, test_mode: true } },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'subscription_payment_recovered' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).subscription_extended, false);
  });

  await runTest('D. Lifecycle', 'D7. Cancelled & Expired subscription (عدم التمديد أو قطع الأيام المدفوعة مسبقاً)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase(),
    });
    for (const evt of ['subscription_cancelled', 'subscription_expired']) {
      const rawBody = JSON.stringify({
        meta: { event_name: evt, custom_data: { user_id: VALID_USER_ID } },
        data: { type: 'subscriptions', id: '307', attributes: { store_id: 55001, test_mode: true } },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': evt },
          body: rawBody,
        }),
      );
      assert.equal(res.status, 200);
      assert.equal((await res.json()).subscription_extended, false);
    }
  });

  await runTest('D. Lifecycle', 'D8. Full Refund (تسجيل الاسترداد الكلي في سجل التسويات دون إيقاف عشوائي للصفحة)', async () => {
    const supabaseMock = createMockSupabase();
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock,
    });
    const rawBody = JSON.stringify({
      meta: {
        event_name: 'order_refunded',
        custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID },
      },
      data: {
        type: 'orders',
        id: '308',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'refunded',
          refunded: true,
          subtotal: 999,
          discount_total: 0,
          tax: 200,
          total: 1199,
          refunded_amount: 1199,
          currency: 'USD',
        },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_refunded' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'reconciliation_logged');
    assert.equal(body.refund_type, 'full');
    assert.equal(body.reason, 'refund_requires_admin_review');
    assert.equal(body.subscription_extended, false);
    assert.equal(supabaseMock.reconciliationLogs.length, 1);
  });

  await runTest(
    'D. Lifecycle',
    'D9. Partial Refund (تمييز الاسترداد الجزئي refunded_amount < total بوحدة السنت وتسجيله للمراجعة الإدارية)',
    async () => {
      const supabaseMock = createMockSupabase();
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock,
      });
      const rawBody = JSON.stringify({
        meta: {
          event_name: 'order_created',
          custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID },
        },
        data: {
          type: 'orders',
          id: '309',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            refunded: false,
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            refunded_amount: 500, // Partial refund of 500 cents out of 1199 cents
            currency: 'USD',
            first_order_item: { variant_id: 101001 },
          },
        },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: rawBody,
        }),
      );
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.status, 'reconciliation_logged');
      assert.equal(body.refund_type, 'partial');
      assert.equal(body.reason, 'partial_refund_requires_admin_review');
      assert.equal(body.refunded_amount_minor, 500);
      assert.equal(body.subscription_extended, false);
    },
  );

  // ============================================================================
  // CATEGORY E: AUTHORIZATION & TAMPERING TESTS (8 TESTS)
  // ============================================================================
  await runTest('E. Security', 'E1. Unauthenticated customer (رفض طلب الدفع بدون JWT صالح)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({ pricingSettings: DEFAULT_SETTINGS }),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer invalid-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1 }),
      }),
    );
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, 'unauthorized');
  });

  await runTest('E. Security', 'E2. Unauthorized page ownership (رفض الدفع لصفحة يملكها مستخدم آخر)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({
        pricingSettings: DEFAULT_SETTINGS,
        pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
      }),
    });
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: 1, page_id: OTHER_PAGE_ID }),
      }),
    );
    assert.equal(res.status, 403);
    assert.equal((await res.json()).error, 'forbidden_page');
  });

  await runTest('E. Security', 'E3. Tampered page_id in webhook (رفض تمديد صفحة لا يملكها المستخدم في Webhook)', async () => {
    const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
      env: BASE_TEST_ENV,
      supabaseMock: createMockSupabase({
        rpcHandler: async () => ({ data: 'page_ownership_mismatch', error: null }),
      }),
    });
    const rawBody = JSON.stringify({
      meta: {
        event_name: 'order_created',
        custom_data: { user_id: VALID_USER_ID, page_id: OTHER_PAGE_ID },
      },
      data: {
        type: 'orders',
        id: '401',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          subtotal: 999,
          discount_total: 0,
          tax: 200,
          total: 1199,
          currency: 'USD',
          first_order_item: { variant_id: 101001 },
        },
      },
    });
    const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
    const res = await handler(
      new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
        body: rawBody,
      }),
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'reconciliation_logged');
    assert.equal(body.result, 'page_ownership_mismatch');
    assert.equal(body.subscription_extended, false);
  });

  await runTest(
    'E. Security',
    'E4. Client-supplied price/days/variant/mode tampering (رفض أي محاولة لتمرير السعر أو المدة من المتصفح)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: DEFAULT_SETTINGS,
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      for (const tamperedBody of [
        { plan: 1, price: 1 },
        { plan: 1, custom_price: 100 },
        { plan: 1, days: 999 },
        { plan: 1, variant_id: '101001' },
        { plan: 1, mode: 'live' },
        { plan: 1, user_id: OTHER_PAGE_ID },
      ]) {
        const res = await handler(
          new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
            method: 'POST',
            headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
            body: JSON.stringify(tamperedBody),
          }),
        );
        assert.equal(res.status, 400);
        assert.equal((await res.json()).error, 'client_override_forbidden');
      }
    },
  );

  await runTest(
    'E. Security',
    'E5. Test/Live Variant Collision & Secret Collision (منع خلط معرفات أو مفاتيح الاختبار مع المباشر)',
    async () => {
      const { handler: variantCollisionHandler } = loadEdgeFunctionHandler(
        'supabase/functions/lemon-checkout/index.ts',
        {
          env: { ...BASE_TEST_ENV, LEMONSQUEEZY_MODE: 'live' },
          supabaseMock: createMockSupabase({
            pricingSettings: {
              ...DEFAULT_SETTINGS,
              payment_mode: 'live',
              payment_provider_mode: 'live',
              plan1_variant_id: '101001',
            },
            pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
          }),
        },
      );
      const r1 = await variantCollisionHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(r1.status, 503);
      assert.equal((await r1.json()).error, 'test_live_variant_collision');

      const { handler: secretCollisionHandler } = loadEdgeFunctionHandler(
        'supabase/functions/lemon-checkout/index.ts',
        {
          env: {
            ...BASE_TEST_ENV,
            LEMONSQUEEZY_TEST_API_KEY: 'same-secret-key',
            LEMONSQUEEZY_LIVE_API_KEY: 'same-secret-key',
          },
          supabaseMock: createMockSupabase({
            pricingSettings: DEFAULT_SETTINGS,
            pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
          }),
        },
      );
      const r2 = await secretCollisionHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(r2.status, 503);
      assert.equal((await r2.json()).error, 'test_live_secret_collision');
    },
  );

  await runTest(
    'E. Security',
    'E6. Database transient failure (إرجاع 500 عند فشل قاعدة البيانات المؤقت ليُعيد المزود المحاولة)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          rpcHandler: async () => ({ data: null, error: { code: '57P01', message: 'db_down' } }),
        }),
      });
      const rawBody = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID } },
        data: {
          type: 'orders',
          id: '402',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            currency: 'USD',
            first_order_item: { variant_id: 101001 },
          },
        },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawBody);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: rawBody,
        }),
      );
      assert.equal(res.status, 500);
      assert.equal((await res.json()).error, 'database_rpc_error');
    },
  );

  await runTest(
    'E. Security',
    'E7. Insecure checkout URL rejection (رفض روابط الدفع غير المشفرة بـ HTTPS)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: DEFAULT_SETTINGS,
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
        fetchMock: async () =>
          new Response(JSON.stringify({ data: { attributes: { url: 'http://insecure.example/pay' } } }), {
            status: 200,
          }),
      });
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(res.status, 502);
      assert.equal((await res.json()).error, 'checkout_failed');
    },
  );

  await runTest(
    'E. Security',
    'E8. SQL Migration & Success View static verification (التحقق من توقيع log_admin_action وحالة الانتظار في success.js)',
    async () => {
      const sqlContent = fs.readFileSync(
        path.join(ROOT_DIR, 'supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql'),
        'utf8',
      );
      assert.match(
        sqlContent,
        /PERFORM\s+public\.log_admin_action\(\s*'resolve_payment_reconciliation',\s*COALESCE\(v_payment\.user_id,\s*v_issue\.user_id\),\s*'payment_reconciliation',\s*v_issue\.id::text,/s,
        'SQL migration must call public.log_admin_action with the exact 5-argument signature',
      );

      const successJsContent = fs.readFileSync(path.join(ROOT_DIR, 'src/views/success.js'), 'utf8');
      assert.match(successJsContent, /payment-pending-banner/, 'success.js must render pending webhook state banner');
      assert.match(successJsContent, /\.eq\('page_id',\s*page\.id\)/, 'success.js must verify page_id ownership');
      assert.match(
        successJsContent,
        /\.eq\('payment_status',\s*'paid'\)/,
        'success.js must verify payment_status === paid',
      );
    },
  );

  await runTest(
    'A. Checkout',
    'A7. Mode mismatch between Environment and Database (رفض الدفع عند اختلاف وضع البيئة عن قاعدة البيانات)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: { ...BASE_TEST_ENV, LEMONSQUEEZY_MODE: 'test' },
        supabaseMock: createMockSupabase({
          pricingSettings: { ...DEFAULT_SETTINGS, payment_mode: 'live', payment_provider_mode: 'live' },
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'mode_configuration_mismatch');
    },
  );

  await runTest(
    'A. Checkout',
    'A8. Generic fallback rejection (منع الاعتماد على LEMONSQUEEZY_API_KEY أو LEMONSQUEEZY_STORE_ID العام)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: {
          ...BASE_TEST_ENV,
          LEMONSQUEEZY_TEST_API_KEY: '',
          LEMONSQUEEZY_API_KEY: 'generic-fallback-key-must-be-ignored',
        },
        supabaseMock: createMockSupabase({
          pricingSettings: DEFAULT_SETTINGS,
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'missing_api_key');
    },
  );

  await runTest(
    'A. Checkout',
    'A9. Duplicate Variant IDs within same mode (رفض تكرار Variant ID بين باقتين داخل نفس الوضع)',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: {
            ...DEFAULT_SETTINGS,
            plan1_test_variant_id: '101001',
            plan2_test_variant_id: '101001',
          },
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(res.status, 503);
      assert.equal((await res.json()).error, 'duplicate_variant_id');
    },
  );

  await runTest(
    'A. Checkout',
    'A10. Price & Currency validation: missing currency, ambiguous separators, and Variant Currency mismatch',
    async () => {
      // 1. Missing currency in price string ("15" without currency -> must NOT assume USD)
      const { handler: hMissingCurr } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: { ...DEFAULT_SETTINGS, plan1_new_price: '15' },
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      const r1 = await hMissingCurr(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(r1.status, 503);
      assert.equal((await r1.json()).error, 'invalid_plan_price');

      // 2. Ambiguous price string ("1,234 USD" or "10 20 USD")
      const { handler: hAmbiguous } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: { ...DEFAULT_SETTINGS, plan1_new_price: '1,234 USD' },
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      const r2 = await hAmbiguous(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(r2.status, 503);
      assert.equal((await r2.json()).error, 'invalid_plan_price');

      // 3. Variant currency mismatch (plan price in EUR while LEMONSQUEEZY_VARIANT_CURRENCY=USD)
      const { handler: hMismatch } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: { ...BASE_TEST_ENV, LEMONSQUEEZY_VARIANT_CURRENCY: 'USD' },
        supabaseMock: createMockSupabase({
          pricingSettings: { ...DEFAULT_SETTINGS, plan1_new_price: '€19.99 EUR' },
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
      });
      const r3 = await hMismatch(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(r3.status, 503);
      assert.equal((await r3.json()).error, 'variant_currency_mismatch');
    },
  );

  await runTest(
    'E. Security',
    'E9. Admin authorization for action=status (منع المستخدم غير المدير من فحص وتحديث حالة الربط)',
    async () => {
      // Non-admin user -> 403 forbidden
      const { handler: nonAdminHandler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          isAdmin: false,
          pricingSettings: DEFAULT_SETTINGS,
        }),
      });
      const rNonAdmin = await nonAdminHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'status' }),
        }),
      );
      assert.equal(rNonAdmin.status, 403);
      assert.equal((await rNonAdmin.json()).error, 'forbidden');

      // Admin user -> 200 OK
      const { handler: adminHandler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          isAdmin: true,
          pricingSettings: DEFAULT_SETTINGS,
        }),
      });
      const rAdmin = await adminHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'status' }),
        }),
      );
      assert.equal(rAdmin.status, 200);
      const statusBody = await rAdmin.json();
      assert.equal(statusBody.status, 'test_mode');
      assert.equal(statusBody.all_variants_configured, true);
    },
  );

  await runTest(
    'E. Security',
    'E10. Untrusted Origin, Oversized Request Body, Invalid Checkout Domain & Ambiguous Page Selection',
    async () => {
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: DEFAULT_SETTINGS,
          pages: [
            { id: VALID_PAGE_ID, user_id: VALID_USER_ID },
            { id: '33333333-3333-4333-8333-333333333333', user_id: VALID_USER_ID },
          ],
        }),
        fetchMock: async () =>
          new Response(
            JSON.stringify({
              data: { attributes: { url: 'https://evil-phishing.example.com/checkout' } },
            }),
            { status: 200 },
          ),
      });

      // 1. Untrusted Origin -> 400 untrusted_origin
      const rOrigin = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1, page_id: VALID_PAGE_ID, origin: 'https://evil.example.com' }),
        }),
      );
      assert.equal(rOrigin.status, 400);
      assert.equal((await rOrigin.json()).error, 'untrusted_origin');

      // 2. Ambiguous page selection when user owns >1 pages and omits page_id -> 400 ambiguous_page_selection
      const rAmbigPage = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(rAmbigPage.status, 400);
      assert.equal((await rAmbigPage.json()).error, 'ambiguous_page_selection');

      // 3. Oversized request body (> 16 KB) -> 413 payload_too_large
      const hugeOrigin = 'https://pageads.ahmedkhalled1994.workers.dev/' + 'a'.repeat(20_000);
      const rLarge = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1, page_id: VALID_PAGE_ID, origin: hugeOrigin }),
        }),
      );
      assert.equal(rLarge.status, 413);
      assert.equal((await rLarge.json()).error, 'payload_too_large');

      // 4. HTTPS checkout URL from non-lemonsqueezy domain -> 502 checkout_failed
      const rBadDomain = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1, page_id: VALID_PAGE_ID }),
        }),
      );
      assert.equal(rBadDomain.status, 502);
      assert.equal((await rBadDomain.json()).error, 'checkout_failed');
    },
  );

  await runTest(
    'E. Security',
    'E11. Checkout Timeout, Concurrent Requests & Rate Limiting per user',
    async () => {
      // 1. Timeout simulation (AbortError -> 504 checkout_timeout)
      const { handler: timeoutHandler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: DEFAULT_SETTINGS,
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
        fetchMock: async () => {
          const abortErr = new Error('The operation was aborted');
          abortErr.name = 'AbortError';
          throw abortErr;
        },
      });
      const rTimeout = await timeoutHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(rTimeout.status, 504);
      assert.equal((await rTimeout.json()).error, 'checkout_timeout');

      // 2. Concurrent requests for same user -> second request blocked with 429 concurrent_checkout_in_progress
      let resolveSlowFetch;
      const slowFetchPromise = new Promise((resolve) => {
        resolveSlowFetch = resolve;
      });
      const { handler: concurrentHandler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          pricingSettings: DEFAULT_SETTINGS,
          pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
        }),
        fetchMock: async () => {
          await slowFetchPromise;
          return new Response(
            JSON.stringify({
              data: { attributes: { url: 'https://pagads.lemonsqueezy.com/checkout/buy/ok' } },
            }),
            { status: 200 },
          );
        },
      });

      const req1Promise = concurrentHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );

      await new Promise((r) => setTimeout(r, 15));

      const req2Res = await concurrentHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
          method: 'POST',
          headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ plan: 1 }),
        }),
      );
      assert.equal(req2Res.status, 429);
      assert.equal((await req2Res.json()).error, 'concurrent_checkout_in_progress');

      resolveSlowFetch();
      const req1Res = await req1Promise;
      assert.equal(req1Res.status, 200);
    },
  );

  await runTest(
    'B. Webhook',
    'B10. Missing data.attributes.test_mode (رفض غياب data.attributes.test_mode حتى لو وُجد meta.test_mode) ورفض Upsert الفاشل بـ 500',
    async () => {
      // 1. Missing data.attributes.test_mode with meta.test_mode=true -> 400 malformed_test_mode_flag
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase(),
      });
      const missingAttrTestMode = JSON.stringify({
        meta: { event_name: 'order_created', test_mode: true },
        data: {
          type: 'orders',
          id: '9001',
          attributes: { store_id: 55001, status: 'paid', total: 1199, currency: 'USD' },
        },
      });
      const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, missingAttrTestMode);
      const res = await handler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
          body: missingAttrTestMode,
        }),
      );
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'malformed_test_mode_flag');
      assert.equal(body.reason, 'missing_boolean_test_mode');

      // 2. Atomic RPC failure on process_lemon_lifecycle_webhook -> 500 database_rpc_error (zero split upsert)
      const failSupabaseMock = createMockSupabase({
        rpcHandler: async () => ({ data: null, error: { message: 'simulated_atomic_rpc_failure' } }),
      });
      const { handler: rpcErrHandler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: failSupabaseMock,
      });
      const refundNoAmount = JSON.stringify({
        meta: { event_name: 'order_refunded', custom_data: { user_id: VALID_USER_ID } },
        data: {
          type: 'orders',
          id: '9002',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'refunded',
            refunded: true,
            total: 1199,
            currency: 'USD',
          },
        },
      });
      const resRpcFail = await rpcErrHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, refundNoAmount),
            'X-Event-Name': 'order_refunded',
          },
          body: refundNoAmount,
        }),
      );
      assert.equal(resRpcFail.status, 500);
      assert.equal((await resRpcFail.json()).error, 'database_rpc_error');
      assert.equal(failSupabaseMock.splitUpsertCalls.length, 0, 'Must never perform split PostgREST upsert');
    },
  );

  await runTest(
    'E. Security',
    'E12. AUD-01 Fail-Closed Rate Limit & Ban Verification (رفض الدفع بـ 500 عند فشل أو غياب check_checkout_rate_limit)',
    async () => {
      const failureModes = [
        {
          name: 'RPC returns error (permission denied / missing function)',
          rpcHandler: async () => ({ data: null, error: { code: '42501', message: 'permission denied' } }),
        },
        {
          name: 'RPC throws network/timeout exception',
          rpcHandler: async () => {
            throw new Error('statement timeout');
          },
        },
        {
          name: 'RPC returns null data',
          rpcHandler: async () => ({ data: null, error: null }),
        },
        {
          name: 'RPC returns unexpected string status',
          rpcHandler: async () => ({ data: 'unexpected_state', error: null }),
        },
      ];

      for (const mode of failureModes) {
        let lemonApiCalled = false;
        const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
          env: BASE_TEST_ENV,
          supabaseMock: createMockSupabase({
            pricingSettings: DEFAULT_SETTINGS,
            pages: [{ id: VALID_PAGE_ID, user_id: VALID_USER_ID }],
            rpcHandler: mode.rpcHandler,
          }),
          fetchMock: async () => {
            lemonApiCalled = true;
            return new Response(
              JSON.stringify({ data: { attributes: { url: 'https://pagads.lemonsqueezy.com/checkout/buy/ok' } } }),
              { status: 200 },
            );
          },
        });

        const res = await handler(
          new Request('https://mock.supabase.co/functions/v1/lemon-checkout', {
            method: 'POST',
            headers: { Authorization: 'Bearer valid-jwt-token', 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan: 1 }),
          }),
        );
        assert.equal(res.status, 500, `Expected 500 for ${mode.name}`);
        const body = await res.json();
        assert.equal(body.error, 'security_verification_failed', `Expected security_verification_failed for ${mode.name}`);
        assert.equal(lemonApiCalled, false, `Lemon Squeezy API must NOT be called when ${mode.name}`);
      }
    },
  );

  await runTest(
    'E. Security',
    'E13. AUD-02 Unified Atomic Single-RPC Refund Classification (تصنيف حالات الاسترداد الـ6 عبر RPC ذري واحد دون Upsert منفصل)',
    async () => {
      const capturedRpcCalls = [];
      const supabaseMock = createMockSupabase({
        rpcHandler: async (fn, args) => {
          capturedRpcCalls.push({ fn, args });
          return { data: 'ok', error: null };
        },
      });
      const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock,
      });

      const cases = [
        {
          id: '9101',
          attrs: { store_id: 55001, test_mode: true, status: 'refunded', refunded: true, total: 1199, refunded_amount: 1199, currency: 'USD' },
          expectedType: 'full',
          expectedAmount: 1199,
          expectedReason: 'refund_requires_admin_review',
        },
        {
          id: '9102',
          attrs: { store_id: 55001, test_mode: true, status: 'paid', refunded: false, total: 1199, refunded_amount: 400, currency: 'USD' },
          expectedType: 'partial',
          expectedAmount: 400,
          expectedReason: 'partial_refund_requires_admin_review',
        },
        {
          id: '9103',
          attrs: { store_id: 55001, test_mode: true, status: 'refunded', refunded: true, total: 1199, refunded_amount: 0, currency: 'USD' },
          expectedType: 'zero_verified',
          expectedAmount: 0,
          expectedReason: 'refund_amount_zero_requires_admin_review',
        },
        {
          id: '9104',
          attrs: { store_id: 55001, test_mode: true, status: 'refunded', refunded: true, total: 1199, refunded_amount: 12.5, currency: 'USD' },
          expectedType: 'fractional_requires_review',
          expectedAmount: null,
          expectedReason: 'refund_amount_fractional_requires_admin_review',
        },
        {
          id: '9105',
          attrs: { store_id: 55001, test_mode: true, status: 'refunded', refunded: true, total: 1199, currency: 'USD' },
          expectedType: 'unknown_missing',
          expectedAmount: null,
          expectedReason: 'refund_amount_unverified_requires_admin_review',
        },
        {
          id: '9106',
          attrs: { store_id: 55001, test_mode: true, status: 'refunded', refunded: true, total: 1199, refunded_amount: 5000, currency: 'USD' },
          expectedType: 'invalid_unverified',
          expectedAmount: null,
          expectedReason: 'refund_amount_unverified_requires_admin_review',
        },
      ];

      for (const tc of cases) {
        const raw = JSON.stringify({
          meta: { event_name: 'order_refunded', custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID } },
          data: { type: 'orders', id: tc.id, attributes: tc.attrs },
        });
        const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, raw);
        const res = await handler(
          new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
            method: 'POST',
            headers: { 'X-Signature': sig, 'X-Event-Name': 'order_refunded' },
            body: raw,
          }),
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.refund_type, tc.expectedType, `Mismatch refund_type for case ${tc.id}`);
        assert.equal(body.refunded_amount_minor, tc.expectedAmount, `Mismatch refunded_amount_minor for case ${tc.id}`);
        assert.equal(body.reason, tc.expectedReason, `Mismatch reason for case ${tc.id}`);
      }

      assert.equal(supabaseMock.splitUpsertCalls.length, 0, 'Zero split PostgREST upserts allowed');
      assert.equal(capturedRpcCalls.length, 6, 'All 6 refund cases must invoke process_lemon_lifecycle_webhook once');
    },
  );

  await runTest(
    'E. Security',
    'E14. AUD-04 No Silent Webhook Drop (توثيق رفض store_id_mismatch وwebhook_mode_mismatch وprovider_disabled_in_db ورفض النتائج المجهولة بـ 500)',
    async () => {
      const codes = ['provider_disabled_in_db', 'webhook_mode_mismatch', 'store_id_mismatch', 'missing_pricing_settings'];
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        const { handler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
          env: BASE_TEST_ENV,
          supabaseMock: createMockSupabase({
            rpcHandler: async () => ({ data: code, error: null }),
          }),
        });
        const raw = JSON.stringify({
          meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID } },
          data: {
            type: 'orders',
            id: String(9201 + i),
            attributes: {
              store_id: 55001,
              test_mode: true,
              status: 'paid',
              subtotal: 999,
              discount_total: 0,
              tax: 200,
              total: 1199,
              currency: 'USD',
              first_order_item: { variant_id: 101001 },
            },
          },
        });
        const sig = signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, raw);
        const res = await handler(
          new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
            method: 'POST',
            headers: { 'X-Signature': sig, 'X-Event-Name': 'order_created' },
            body: raw,
          }),
        );
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.status, 'reconciliation_logged');
        assert.equal(body.result, code);
        assert.equal(body.subscription_extended, false);
      }

      // Unknown RPC result -> 500 unexpected_rpc_result (never silently accepted as 200)
      const { handler: unknownHandler } = loadEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
        env: BASE_TEST_ENV,
        supabaseMock: createMockSupabase({
          rpcHandler: async () => ({ data: 'mystery_unhandled_code', error: null }),
        }),
      });
      const rawUnknown = JSON.stringify({
        meta: { event_name: 'order_created', custom_data: { user_id: VALID_USER_ID, page_id: VALID_PAGE_ID } },
        data: {
          type: 'orders',
          id: '9299',
          attributes: {
            store_id: 55001,
            test_mode: true,
            status: 'paid',
            subtotal: 999,
            discount_total: 0,
            tax: 200,
            total: 1199,
            currency: 'USD',
            first_order_item: { variant_id: 101001 },
          },
        },
      });
      const resUnknown = await unknownHandler(
        new Request('https://mock.supabase.co/functions/v1/lemon-webhook', {
          method: 'POST',
          headers: {
            'X-Signature': signPayload(BASE_TEST_ENV.LEMONSQUEEZY_TEST_WEBHOOK_SECRET, rawUnknown),
            'X-Event-Name': 'order_created',
          },
          body: rawUnknown,
        }),
      );
      assert.equal(resUnknown.status, 500);
      assert.equal((await resUnknown.json()).error, 'unexpected_rpc_result');
    },
  );

  const passedCount = results.filter((r) => r.passed).length;
  console.log('====================================================================');
  console.log(`النتيجة النهائية لاختبارات المحاكاة (MOCKED TESTS): ${passedCount}/${results.length} ناجحة`);
  console.log('ملاحظة: هذه اختبارات محاكاة معزولة ولا تمثل اتصالاً حقيقياً بمزود الدفع.');
  console.log('====================================================================');
})();

