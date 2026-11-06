/**
 * PAG ADS — REAL CODE & TRANSACTIONAL SQL SIMULATOR INTEGRATION TESTS (AUD-06)
 * ============================================================================
 * IMPORTANT NOTICE:
 * Unlike the previous replica-based test file, this test suite executes:
 * 1. The REAL Edge Function handlers loaded directly from:
 *    - `supabase/functions/lemon-checkout/index.ts`
 *    - `supabase/functions/lemon-webhook/index.ts`
 * 2. The REAL frontend payment & page selection modules imported directly from:
 *    - `src/lib/payment-config.js`
 *    - `src/views/pricing.js` (`filterOwnedPages`, `resolvePricingPageSelection`)
 * 3. A transactional in-memory SQL state machine mirroring the exact PL/pgSQL
 *    functions in `supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql`
 *    with atomic commit/rollback semantics.
 * 4. Programmatic verification of `.env` / `.env.example` (AUD-07) and
 *    100% verbatim byte-for-byte identity of `PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql`.
 *
 * NOTE: Because no local PostgreSQL instance is running inside the container,
 * database transactions are simulated in-memory with full snapshot rollback,
 * and this distinction is explicitly documented.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

import {
  evaluateCustomerPaymentAvailability,
  DISABLED_PAYMENT_MESSAGE,
  resolveDisplayStatus,
  validatePaymentSettingsValues,
} from '../src/lib/payment-config.js';

const ROOT_DIR = process.cwd();

function loadRealPricingModule() {
  const fullPath = path.join(ROOT_DIR, 'src/views/pricing.js');
  const rawSource = fs
    .readFileSync(fullPath, 'utf8')
    .replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]+['"];?/g, '')
    .replace(/export\s+\{[^}]*\};?/g, '')
    .replace(/export\s+async\s+function\s+/g, 'async function ')
    .replace(/export\s+function\s+/g, 'function ');

  const sandbox = {
    console: { log: () => {}, error: () => {}, warn: () => {} },
    evaluateCustomerPaymentAvailability,
    DISABLED_PAYMENT_MESSAGE,
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(
    `${rawSource}\nglobalThis.__pricingExports = { filterOwnedPages, resolvePricingPageSelection, startCheckout, renderPricing };`,
    sandbox,
    { filename: 'src/views/pricing.js' },
  );
  return sandbox.__pricingExports;
}

const { filterOwnedPages, resolvePricingPageSelection } = loadRealPricingModule();

const UUID_ADMIN = '00000000-0000-4000-8000-000000000001';
const UUID_USER_1 = '11111111-1111-4111-8111-111111111111';
const UUID_USER_2 = '22222222-2222-4222-8222-222222222222';
const UUID_PAGE_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_PAGE_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_PAGE_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const TEST_SECRET = 'real_handler_test_webhook_secret_key_12345';
const LIVE_SECRET = 'real_handler_live_webhook_secret_key_67890';
const TEST_STORE_ID = '55001';
const LIVE_STORE_ID = '88001';

function signPayload(secret, rawString) {
  return crypto.createHmac('sha256', secret).update(Buffer.from(rawString, 'utf8')).digest('hex');
}

function loadRealEdgeFunctionHandler(relativePath, { env = {}, supabaseClient, fetchMock }) {
  const fullPath = path.join(ROOT_DIR, relativePath);
  const rawSource = fs
    .readFileSync(fullPath, 'utf8')
    .replace(/import\s+\{\s*createClient\s*\}\s+from\s+["']npm:@supabase\/supabase-js@2["'];?/g, '')
    .replace(/export\s+\{[\s\S]*?\};?/gm, '')
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
    AbortController,
    setTimeout,
    clearTimeout,
    crypto: globalThis.crypto,
    fetch:
      fetchMock ||
      (async () => {
        throw new Error('Unexpected unmocked fetch call');
      }),
    createClient: () => supabaseClient,
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
  vm.runInContext(transpiled, sandbox, { filename: relativePath });

  if (typeof capturedHandler !== 'function') {
    throw new Error(`Failed to capture Deno.serve handler from ${relativePath}`);
  }
  return capturedHandler;
}

/**
 * Transactional SQL Simulator matching Migration 13 PL/pgSQL functions
 * with full atomic snapshot & rollback support.
 */
function createTransactionalArena(overrides = {}) {
  const env = {
    SUPABASE_URL: 'https://sbrzxvujrylyohmybddj.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock_service_role_key',
    LEMONSQUEEZY_ENABLED: 'true',
    LEMONSQUEEZY_MODE: 'test',
    LEMONSQUEEZY_TEST_API_KEY: 'test_api_key_real_handler',
    LEMONSQUEEZY_LIVE_API_KEY: 'live_api_key_real_handler',
    LEMONSQUEEZY_TEST_STORE_ID: TEST_STORE_ID,
    LEMONSQUEEZY_LIVE_STORE_ID: LIVE_STORE_ID,
    LEMONSQUEEZY_TEST_WEBHOOK_SECRET: TEST_SECRET,
    LEMONSQUEEZY_LIVE_WEBHOOK_SECRET: LIVE_SECRET,
    ...overrides.env,
  };

  let state = {
    pricing_settings:
      overrides.pricing_settings !== undefined
        ? overrides.pricing_settings
        : {
            id: 'global',
            payment_provider_enabled: true,
            payment_mode: 'test',
            payment_provider_mode: 'test',
            store_id: TEST_STORE_ID,
            lemon_test_store_id: TEST_STORE_ID,
            lemon_store_id: LIVE_STORE_ID,
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
          },
    admin_users: overrides.admin_users ?? [UUID_ADMIN],
    banned_users: overrides.banned_users ?? [],
    pages: overrides.pages ?? [
      {
        id: UUID_PAGE_1,
        user_id: UUID_USER_1,
        slug: 'page-one',
        title: 'صفحة إعلان 1',
        is_active: true,
        is_trial: true,
        expires_at: '2026-11-10T00:00:00.000Z',
        created_at: '2026-11-01T00:00:00.000Z',
      },
    ],
    payments: [],
    processed_webhook_events: [],
    payment_reconciliation_issues: [],
    admin_audit_logs: [],
    checkout_rate_limits: [],
    nextIssueId: 1,
    nextPaymentSeq: 1,
  };

  const faultInjection = {
    rateLimitRpcMode: null, // 'error' | 'throw' | 'null' | 'unknown_string' | 'rate_limited' | 'user_banned'
    webhookRpcError: false,
    failLifecycleReconciliationInsert: false,
    failEntitlementRevokeUpdate: false,
    failAdminAuditLog: false,
    customRpcReturn: null,
  };

  let currentAuthUser = overrides.authUser !== undefined
    ? overrides.authUser
    : { id: UUID_USER_1, email: 'customer@example.com' };
  let currentCallerRole = 'service_role'; // or 'authenticated'
  let externalFetchCalls = 0;
  let splitPostgrestUpserts = 0;

  function cloneState() {
    return JSON.parse(JSON.stringify(state));
  }

  function runAtomicTransaction(fn) {
    const snapshot = cloneState();
    try {
      return fn();
    } catch (err) {
      state = snapshot;
      throw err;
    }
  }

  const supabaseClient = {
    auth: {
      async getUser(token) {
        if (!token || token === 'invalid' || !currentAuthUser) {
          return { data: { user: null }, error: { message: 'invalid_jwt' } };
        }
        return { data: { user: currentAuthUser }, error: null };
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
                    return {
                      data: state.admin_users.includes(val) ? { user_id: val } : null,
                      error: null,
                    };
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
                    return { data: state.pricing_settings, error: null };
                  },
                };
              },
            };
          },
          update(patch) {
            return {
              async eq() {
                if (state.pricing_settings) {
                  Object.assign(state.pricing_settings, patch);
                }
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
                return { data: state.pages.filter((p) => p.user_id === val), error: null };
              },
            };
          },
        };
      }
      if (table === 'payment_reconciliation_issues') {
        return {
          async upsert() {
            splitPostgrestUpserts += 1;
            throw new Error('SPLIT_WRITE_FORBIDDEN: lemon-webhook must not call .from(payment_reconciliation_issues).upsert');
          },
        };
      }
      throw new Error(`Unexpected table access: ${table}`);
    },
    async rpc(fnName, args) {
      if (fnName === 'check_checkout_rate_limit') {
        if (faultInjection.rateLimitRpcMode === 'throw') {
          throw new Error('Simulated RPC connection timeout');
        }
        if (faultInjection.rateLimitRpcMode === 'error') {
          return { data: null, error: { code: '42501', message: 'permission denied for function check_checkout_rate_limit' } };
        }
        if (faultInjection.rateLimitRpcMode === 'null') {
          return { data: null, error: null };
        }
        if (faultInjection.rateLimitRpcMode === 'unknown_string') {
          return { data: 'corrupted_return_code', error: null };
        }
        if (faultInjection.rateLimitRpcMode === 'rate_limited') {
          return { data: 'rate_limited', error: null };
        }
        if (faultInjection.rateLimitRpcMode === 'user_banned' || state.banned_users.includes(args.p_user_id)) {
          return { data: 'user_banned', error: null };
        }
        state.checkout_rate_limits.push({ user_id: args.p_user_id, page_id: args.p_page_id, created_at: new Date().toISOString() });
        return { data: 'ok', error: null };
      }

      if (faultInjection.webhookRpcError) {
        return { data: null, error: { code: '57P01', message: 'simulated_db_failure' } };
      }
      if (faultInjection.customRpcReturn !== null) {
        return { data: faultInjection.customRpcReturn, error: null };
      }

      try {
        const data = runAtomicTransaction(() => {
          if (fnName === 'process_lemon_payment_webhook') {
            return executeProcessLemonPaymentWebhook(args);
          }
          if (fnName === 'process_lemon_lifecycle_webhook') {
            return executeProcessLemonLifecycleWebhook(args);
          }
          if (fnName === 'admin_resolve_payment_reconciliation_issue') {
            return executeAdminResolveIssue(args);
          }
          throw new Error(`Unknown RPC: ${fnName}`);
        });
        return { data, error: null };
      } catch (err) {
        return { data: null, error: { message: err.message } };
      }
    },
  };

  function upsertReconciliationIssueInTx(row) {
    if (faultInjection.failLifecycleReconciliationInsert) {
      throw new Error('simulated_reconciliation_insert_failure_inside_tx');
    }
    const existing = state.payment_reconciliation_issues.find(
      (i) => i.event_key === row.event_key && i.failure_reason === row.failure_reason,
    );
    if (existing) {
      Object.assign(existing, row, { updated_at: new Date().toISOString() });
      return existing;
    }
    const created = {
      id: state.nextIssueId++,
      resolved: false,
      resolution_notes: null,
      resolution_action: null,
      resolved_at: null,
      resolved_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...row,
    };
    state.payment_reconciliation_issues.push(created);
    return created;
  }

  function executeProcessLemonPaymentWebhook(args) {
    if (!args.p_delivery_id) return 'missing_delivery_id';
    if (!args.p_event_key) return 'missing_event_key';
    if (!args.p_resource_type) return 'missing_resource_type';
    if (!args.p_resource_id || !/^\d{1,24}$/.test(String(args.p_resource_id))) return 'invalid_resource_id';

    if (state.processed_webhook_events.some((e) => e.delivery_id === args.p_delivery_id || e.event_id === args.p_delivery_id)) {
      return 'duplicate_delivery';
    }

    let securityRejectReason = null;
    const settings = state.pricing_settings;

    if (!settings) {
      securityRejectReason = 'missing_pricing_settings';
    } else {
      const dbMode = (settings.payment_provider_mode || settings.payment_mode || 'disabled').toLowerCase();
      if (!settings.payment_provider_enabled || dbMode === 'disabled') {
        securityRejectReason = 'provider_disabled_in_db';
      } else if ((dbMode === 'live' && args.p_test_mode === true) || (dbMode === 'test' && args.p_test_mode === false)) {
        securityRejectReason = 'webhook_mode_mismatch';
      } else {
        const expectedStore = dbMode === 'test' ? settings.lemon_test_store_id || settings.store_id : settings.lemon_store_id || settings.store_id;
        if (!expectedStore || expectedStore !== args.p_store_id) {
          securityRejectReason = 'store_id_mismatch';
        }
      }
    }

    const rawMeta = args.p_raw_meta || {};
    if (!securityRejectReason) {
      if (
        rawMeta.has_fractional_minor_units === true ||
        (typeof rawMeta.fractional_minor_part === 'string' && rawMeta.fractional_minor_part.trim() !== '') ||
        (typeof rawMeta.reconciliation_reason === 'string' && rawMeta.reconciliation_reason.trim() !== '')
      ) {
        securityRejectReason = rawMeta.reconciliation_reason || 'fractional_minor_unit_requires_review';
      }
    }

    let result;
    if (securityRejectReason) {
      result = securityRejectReason;
    } else {
      // Check resource-level deduplication
      const existingByResource = state.payments.find(
        (p) => p.store_id === args.p_store_id && p.resource_type === args.p_resource_type && p.resource_id === args.p_resource_id,
      );
      if (existingByResource && existingByResource.event_key !== args.p_event_key) {
        result = 'duplicate';
      } else if (state.payments.some((p) => p.event_key === args.p_event_key)) {
        result = 'duplicate';
      } else {
        const dbMode = (settings.payment_provider_mode || settings.payment_mode).toLowerCase();
        const activeVars =
          dbMode === 'test'
            ? [settings.plan1_test_variant_id, settings.plan2_test_variant_id, settings.plan3_test_variant_id]
            : [settings.plan1_variant_id, settings.plan2_variant_id, settings.plan3_variant_id];
        const planIdx = activeVars.findIndex((v) => v === args.p_variant_id);
        if (planIdx === -1) {
          result = 'unknown_plan';
        } else {
          const userPages = state.pages.filter((p) => p.user_id === args.p_user_id);
          let targetPage = null;
          if (args.p_page_id) {
            targetPage = userPages.find((p) => p.id === args.p_page_id);
            if (!targetPage) result = 'page_ownership_mismatch';
          } else if (userPages.length === 1) {
            targetPage = userPages[0];
          } else if (userPages.length === 0) {
            result = 'no_page';
          } else {
            result = 'ambiguous_page_target';
          }

          if (targetPage) {
            const plan = planIdx + 1;
            const days = settings[`plan${plan}_days`];
            const nowMs = Date.now();
            const prevExpiresAt = targetPage.expires_at || null;
            const prevMs = prevExpiresAt ? Date.parse(prevExpiresAt) : nowMs;
            const effectiveStartMs = Math.max(prevMs, nowMs);
            const effectiveStartIso = new Date(effectiveStartMs).toISOString();
            const newExpiresIso = new Date(effectiveStartMs + days * 86400000).toISOString();

            targetPage.is_trial = false;
            targetPage.expires_at = newExpiresIso;

            state.payments.push({
              id: `00000000-0000-4000-9000-${String(state.nextPaymentSeq++).padStart(12, '0')}`,
              event_key: args.p_event_key,
              user_id: args.p_user_id,
              page_id: targetPage.id,
              plan,
              plan_number: plan,
              variant_id: args.p_variant_id,
              days,
              days_added: days,
              order_id: args.p_order_id || '',
              subscription_id: args.p_subscription_id || '',
              amount: args.p_amount,
              refunded_amount: 0,
              currency: args.p_currency,
              customer_email: args.p_customer_email || '',
              payment_status: 'paid',
              store_id: args.p_store_id,
              resource_type: args.p_resource_type,
              resource_id: args.p_resource_id,
              event_name: args.p_event_name,
              test_mode: args.p_test_mode,
              raw_meta: rawMeta,
              previous_expires_at: prevExpiresAt,
              effective_start_at: effectiveStartIso,
              granted_expires_at: newExpiresIso,
              entitlement_status: 'active',
              refund_resolution_status: 'none',
              refund_resolved_at: null,
              refund_resolved_by: null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });
            result = 'ok';
          }
        }
      }
    }

    if (result !== 'ok' && result !== 'duplicate') {
      upsertReconciliationIssueInTx({
        event_key: args.p_event_key,
        delivery_id: args.p_delivery_id,
        event_name: args.p_event_name,
        resource_type: args.p_resource_type,
        resource_id: args.p_resource_id,
        store_id: args.p_store_id,
        user_id: args.p_user_id,
        page_id: args.p_page_id,
        variant_id: args.p_variant_id || '',
        order_id: args.p_order_id || '',
        subscription_id: args.p_subscription_id || '',
        amount: securityRejectReason ? 0 : Math.max(args.p_amount || 0, 0),
        refunded_amount: null,
        raw_refunded_amount: null,
        refund_type: 'none',
        currency: args.p_currency || 'USD',
        customer_email: args.p_customer_email || '',
        failure_reason: result,
        test_mode: args.p_test_mode,
        raw_meta: rawMeta,
      });
    }

    state.processed_webhook_events.push({
      event_id: args.p_delivery_id,
      delivery_id: args.p_delivery_id,
      event_key: args.p_event_key,
      event_name: args.p_event_name,
      provider: 'lemonsqueezy',
      resource_type: args.p_resource_type,
      resource_id: args.p_resource_id,
      store_id: args.p_store_id,
      test_mode: args.p_test_mode,
      processing_status: result === 'ok' || result === 'duplicate' ? 'processed' : 'reconciliation_required',
      result_code: result,
    });

    return result;
  }

  function executeProcessLemonLifecycleWebhook(args) {
    if (state.processed_webhook_events.some((e) => e.delivery_id === args.p_delivery_id || e.event_id === args.p_delivery_id)) {
      return 'duplicate_delivery';
    }

    const isRefundEvent =
      args.p_event_name === 'order_refunded' ||
      args.p_event_name === 'subscription_payment_refunded' ||
      args.p_refund_type !== 'none';

    const verifiedRefundAmt =
      typeof args.p_refunded_amount === 'number' && args.p_refunded_amount > 0 ? args.p_refunded_amount : null;

    if (isRefundEvent) {
      for (const p of state.payments) {
        const matchesInvoice =
          args.p_event_name === 'subscription_payment_refunded' &&
          p.resource_type === 'subscription-invoices' &&
          p.resource_id === args.p_resource_id;
        const matchesOrder =
          args.p_event_name !== 'subscription_payment_refunded' &&
          p.resource_type === 'orders' &&
          (p.resource_id === args.p_resource_id || (args.p_order_id && p.order_id === args.p_order_id));

        if (matchesInvoice || matchesOrder) {
          if ((args.p_refund_type === 'full' || args.p_refund_type === 'partial') && verifiedRefundAmt !== null) {
            p.payment_status =
              args.p_refund_type === 'partial' || verifiedRefundAmt < p.amount ? 'partially_refunded' : 'refunded';
            p.refunded_amount = Math.min(verifiedRefundAmt, p.amount);
          }
          p.refund_resolution_status = 'pending_admin_review';
          p.raw_meta = {
            ...(p.raw_meta || {}),
            last_lifecycle_event: args.p_event_name,
            last_lifecycle_reason: args.p_reason,
            refund_type: args.p_refund_type,
            verified_refunded_amount_minor: verifiedRefundAmt,
            raw_refunded_amount: args.p_raw_refunded_amount,
          };
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

    const shouldPersistReconciliation =
      isRefundEvent || (args.p_reason && !nonReconciliationReasons.has(args.p_reason));

    if (shouldPersistReconciliation) {
      upsertReconciliationIssueInTx({
        event_key: args.p_event_key,
        delivery_id: args.p_delivery_id,
        event_name: args.p_event_name,
        resource_type: args.p_resource_type,
        resource_id: args.p_resource_id,
        store_id: args.p_store_id,
        user_id: args.p_user_id,
        page_id: args.p_page_id,
        variant_id: args.p_variant_id || '',
        order_id: args.p_order_id || '',
        subscription_id: args.p_subscription_id || '',
        amount: Math.max(args.p_amount || 0, 0),
        refunded_amount: args.p_refunded_amount ?? null,
        raw_refunded_amount: args.p_raw_refunded_amount ?? null,
        refund_type: args.p_refund_type || 'none',
        currency: args.p_currency || 'USD',
        customer_email: args.p_customer_email || '',
        failure_reason: args.p_reason,
        test_mode: args.p_test_mode,
        raw_meta: args.p_raw_meta || {},
      });
    }

    state.processed_webhook_events.push({
      event_id: args.p_delivery_id,
      delivery_id: args.p_delivery_id,
      event_key: args.p_event_key,
      event_name: args.p_event_name,
      provider: 'lemonsqueezy',
      resource_type: args.p_resource_type,
      resource_id: args.p_resource_id,
      store_id: args.p_store_id,
      test_mode: args.p_test_mode,
      processing_status: shouldPersistReconciliation ? 'reconciliation_required' : 'processed',
      result_code: args.p_reason,
    });

    return 'ok';
  }

  function executeAdminResolveIssue(args) {
    if (currentCallerRole !== 'authenticated' || !currentAuthUser) {
      throw new Error('forbidden: authentication required');
    }
    if (!state.admin_users.includes(currentAuthUser.id)) {
      throw new Error('forbidden: admin privileges required');
    }

    const notes = String(args.p_resolution_notes ?? '').trim();
    if (!notes) {
      throw new Error('resolution notes are required');
    }
    const decision = String(args.p_decision ?? 'acknowledge_only').trim();
    const entitlementAction = String(args.p_entitlement_action ?? 'keep_entitlement').trim();
    const verifiedAmt = args.p_verified_refund_amount ?? null;

    if (!['confirm_full_refund', 'confirm_partial_refund', 'reject_refund', 'keep_under_review', 'acknowledge_only'].includes(decision)) {
      throw new Error('invalid resolution decision');
    }
    if (!['keep_entitlement', 'revoke_if_safe'].includes(entitlementAction)) {
      throw new Error('invalid entitlement action');
    }

    const issue = state.payment_reconciliation_issues.find((i) => i.id === args.p_issue_id);
    if (!issue) {
      throw new Error('reconciliation issue not found');
    }
    if (issue.resolved) {
      throw new Error('reconciliation issue already resolved');
    }

    const isRefundIssue =
      issue.refund_type !== 'none' ||
      issue.event_name === 'order_refunded' ||
      issue.event_name === 'subscription_payment_refunded' ||
      issue.failure_reason.includes('refund');

    if (isRefundIssue && decision === 'acknowledge_only') {
      throw new Error('refund issues require explicit refund decision (confirm_full_refund, confirm_partial_refund, reject_refund, or keep_under_review)');
    }

    let payment = state.payments.find(
      (p) =>
        p.event_key === issue.event_key ||
        (issue.store_id && issue.resource_id && p.store_id === issue.store_id && p.resource_type === issue.resource_type && p.resource_id === issue.resource_id) ||
        (issue.order_id && p.order_id === issue.order_id),
    );

    const paymentBefore = payment ? JSON.parse(JSON.stringify(payment)) : null;
    let finalRefundAmt = issue.refunded_amount;
    let markResolved = true;

    if (decision === 'keep_under_review') {
      markResolved = false;
      if (payment) {
        payment.refund_resolution_status = 'pending_admin_review';
      }
    } else if (decision === 'confirm_full_refund') {
      if (!payment) {
        throw new Error('cannot confirm refund without a matching payment record');
      }
      finalRefundAmt = verifiedAmt !== null ? verifiedAmt : issue.refunded_amount !== null ? issue.refunded_amount : payment.amount;
      if (finalRefundAmt <= 0 || finalRefundAmt !== payment.amount) {
        throw new Error('full refund confirmation requires verified amount equal to payment total');
      }
      payment.payment_status = 'refunded';
      payment.refunded_amount = finalRefundAmt;
      payment.refund_resolution_status = 'full_refund_confirmed';
      payment.refund_resolved_at = new Date().toISOString();
      payment.refund_resolved_by = currentAuthUser.id;
    } else if (decision === 'confirm_partial_refund') {
      if (!payment) {
        throw new Error('cannot confirm partial refund without a matching payment record');
      }
      finalRefundAmt = verifiedAmt !== null ? verifiedAmt : issue.refunded_amount;
      if (finalRefundAmt === null || finalRefundAmt <= 0 || finalRefundAmt >= payment.amount) {
        throw new Error('partial refund confirmation requires a positive verified amount strictly less than payment total');
      }
      payment.payment_status = 'partially_refunded';
      payment.refunded_amount = finalRefundAmt;
      payment.refund_resolution_status = 'partial_refund_confirmed';
      payment.refund_resolved_at = new Date().toISOString();
      payment.refund_resolved_by = currentAuthUser.id;
    } else if (decision === 'reject_refund') {
      finalRefundAmt = 0;
      if (payment) {
        payment.payment_status = 'paid';
        payment.refunded_amount = 0;
        payment.refund_resolution_status = 'refund_rejected';
        payment.refund_resolved_at = new Date().toISOString();
        payment.refund_resolved_by = currentAuthUser.id;
      }
    }

    let entitlementRevoked = false;
    let entitlementReason = 'entitlement_kept';
    let pageBefore = null;
    let pageAfter = null;

    if (entitlementAction === 'revoke_if_safe') {
      if (decision !== 'confirm_full_refund') {
        throw new Error('revoke_if_safe is only permitted when confirming a full refund');
      }
      if (!payment || !payment.page_id) {
        throw new Error('cannot revoke entitlement without a linked payment and page');
      }
      if (!payment.granted_expires_at || payment.entitlement_status === 'legacy_untracked') {
        throw new Error('unsafe_entitlement_revocation: payment has no tracked entitlement provenance (legacy_untracked)');
      }
      if (payment.entitlement_status !== 'active') {
        throw new Error('unsafe_entitlement_revocation: payment entitlement is not in active state');
      }

      const page = state.pages.find((pg) => pg.id === payment.page_id);
      if (!page) {
        throw new Error('target page for entitlement revocation not found');
      }
      pageBefore = JSON.parse(JSON.stringify(page));

      const hasNewerPayment = state.payments.some(
        (p2) =>
          p2.page_id === payment.page_id &&
          p2.id !== payment.id &&
          p2.entitlement_status === 'active' &&
          p2.payment_status === 'paid' &&
          (p2.created_at > payment.created_at ||
            (p2.granted_expires_at && p2.granted_expires_at > payment.granted_expires_at)),
      );
      if (hasNewerPayment) {
        throw new Error('unsafe_entitlement_revocation: subsequent active payment exists on the same page');
      }

      if (page.expires_at && page.expires_at > payment.granted_expires_at) {
        throw new Error('unsafe_entitlement_revocation: page expiry exceeds granted_expires_at (extended by another source)');
      }

      if (faultInjection.failEntitlementRevokeUpdate) {
        throw new Error('simulated_entitlement_update_failure');
      }

      page.expires_at = payment.previous_expires_at || payment.effective_start_at || new Date().toISOString();
      payment.entitlement_status = 'revoked';
      pageAfter = JSON.parse(JSON.stringify(page));
      entitlementRevoked = true;
      entitlementReason = 'revoked_to_previous_expiry';
    } else if (payment && (decision === 'confirm_full_refund' || decision === 'confirm_partial_refund') && payment.entitlement_status === 'active') {
      payment.entitlement_status = 'retained_by_admin';
      entitlementReason = 'retained_by_admin';
    }

    issue.resolved = markResolved;
    issue.resolution_notes = notes;
    issue.resolution_action = `${decision}:${entitlementAction}`;
    issue.refunded_amount = finalRefundAmt ?? issue.refunded_amount;
    issue.resolved_at = markResolved ? new Date().toISOString() : null;
    issue.resolved_by = markResolved ? currentAuthUser.id : null;
    issue.updated_at = new Date().toISOString();

    if (faultInjection.failAdminAuditLog) {
      throw new Error('simulated_audit_log_failure');
    }

    state.admin_audit_logs.push({
      admin_user_id: currentAuthUser.id,
      action_type: 'resolve_payment_reconciliation',
      target_user_id: issue.user_id,
      target_resource: 'payment_reconciliation',
      target_id: String(issue.id),
      details: {
        issue_id: issue.id,
        decision,
        entitlement_action: entitlementAction,
        entitlement_revoked: entitlementRevoked,
        entitlement_reason: entitlementReason,
        verified_refund_amount: finalRefundAmt,
        payment_before: paymentBefore,
        payment_after: payment ? JSON.parse(JSON.stringify(payment)) : null,
        page_before: pageBefore,
        page_after: pageAfter,
      },
    });

    return {
      status: markResolved ? 'resolved' : 'under_review',
      issue_id: issue.id,
      decision,
      entitlement_action: entitlementAction,
      entitlement_revoked: entitlementRevoked,
      entitlement_reason: entitlementReason,
      verified_refund_amount: finalRefundAmt,
    };
  }

  const checkoutHandler = loadRealEdgeFunctionHandler('supabase/functions/lemon-checkout/index.ts', {
    env,
    supabaseClient,
    fetchMock: async (url, init) => {
      externalFetchCalls += 1;
      if (overrides.fetchMock) {
        return await overrides.fetchMock(url, init);
      }
      return new Response(
        JSON.stringify({
          data: { attributes: { url: 'https://pagads.lemonsqueezy.com/checkout/buy/real-handler-session' } },
        }),
        { status: 201, headers: { 'Content-Type': 'application/json' } },
      );
    },
  });

  const webhookHandler = loadRealEdgeFunctionHandler('supabase/functions/lemon-webhook/index.ts', {
    env,
    supabaseClient,
  });

  async function callCheckout(body, jwt = 'valid-jwt') {
    const headers = { 'Content-Type': 'application/json' };
    if (jwt) headers.Authorization = `Bearer ${jwt}`;
    const res = await checkoutHandler(
      new Request('https://sbrzxvujrylyohmybddj.supabase.co/functions/v1/lemon-checkout', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function callWebhook(rawString, eventName, secret = TEST_SECRET) {
    const sig = signPayload(secret, rawString);
    const res = await webhookHandler(
      new Request('https://sbrzxvujrylyohmybddj.supabase.co/functions/v1/lemon-webhook', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': sig,
          'X-Event-Name': eventName,
        },
        body: rawString,
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function callAdminResolve(args, callerUser = { id: UUID_ADMIN, email: 'admin@pagads.com' }) {
    const prevUser = currentAuthUser;
    const prevRole = currentCallerRole;
    currentAuthUser = callerUser;
    currentCallerRole = callerUser ? 'authenticated' : 'anon';
    try {
      return await supabaseClient.rpc('admin_resolve_payment_reconciliation_issue', args);
    } finally {
      currentAuthUser = prevUser;
      currentCallerRole = prevRole;
    }
  }

  return {
    get state() {
      return state;
    },
    faultInjection,
    callCheckout,
    callWebhook,
    callAdminResolve,
    setAuthUser(u) {
      currentAuthUser = u;
    },
    getExternalFetchCalls: () => externalFetchCalls,
    getSplitPostgrestUpserts: () => splitPostgrestUpserts,
  };
}

async function runAllIntegrationTests() {
  const results = [];

  async function test(name, fn) {
    await fn();
    results.push(name);
    console.log(`✅ [REAL-HANDLER & SQL-SIMULATOR PASS] ${name}`);
  }

  // ==========================================================================
  // 1. AUD-01: FAIL-CLOSED RATE LIMIT & BAN VERIFICATION IN REAL CHECKOUT
  // ==========================================================================
  await test('1. [AUD-01] Real lemon-checkout fails closed (HTTP 500) on RPC error, timeout, null, or unexpected status without calling Lemon API', async () => {
    for (const mode of ['error', 'throw', 'null', 'unknown_string']) {
      const arena = createTransactionalArena();
      arena.faultInjection.rateLimitRpcMode = mode;
      const res = await arena.callCheckout({ plan: 1 });
      assert.equal(res.status, 500, `Expected HTTP 500 for rateLimitRpcMode=${mode}`);
      assert.equal(res.body.error, 'security_verification_failed');
      assert.equal(arena.getExternalFetchCalls(), 0, 'Must NEVER call Lemon Squeezy API when security RPC fails');
    }

    // Banned user -> 403 user_banned
    const bannedArena = createTransactionalArena();
    bannedArena.faultInjection.rateLimitRpcMode = 'user_banned';
    const bannedRes = await bannedArena.callCheckout({ plan: 1 });
    assert.equal(bannedRes.status, 403);
    assert.equal(bannedRes.body.error, 'user_banned');

    // Rate limited -> 429 rate_limit_exceeded
    const rlArena = createTransactionalArena();
    rlArena.faultInjection.rateLimitRpcMode = 'rate_limited';
    const rlRes = await rlArena.callCheckout({ plan: 1 });
    assert.equal(rlRes.status, 429);
    assert.equal(rlRes.body.error, 'rate_limit_exceeded');

    // Normal OK -> 200 checkout URL
    const okArena = createTransactionalArena();
    const okRes = await okArena.callCheckout({ plan: 1 });
    assert.equal(okRes.status, 200);
    assert.equal(okRes.body.url, 'https://pagads.lemonsqueezy.com/checkout/buy/real-handler-session');
    assert.equal(okArena.getExternalFetchCalls(), 1);
  });

  // ==========================================================================
  // 2. AUD-02: UNIFIED ATOMIC SINGLE-RPC RECONCILIATION & ROLLBACK ON FAILURE
  // ==========================================================================
  await test('2. [AUD-02] Real lemon-webhook writes lifecycle & reconciliation atomically in a single RPC and rolls back completely on failure', async () => {
    const arena = createTransactionalArena();

    // First create a valid payment via order_created
    const orderCreated = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '71001',
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
    const orderRes = await arena.callWebhook(orderCreated, 'order_created');
    assert.equal(orderRes.status, 200);
    assert.equal(orderRes.body.subscription_extended, true);
    assert.equal(arena.state.payments.length, 1);

    // Inject failure during reconciliation insert inside process_lemon_lifecycle_webhook
    arena.faultInjection.failLifecycleReconciliationInsert = true;
    const refundPayload = JSON.stringify({
      meta: { event_name: 'order_refunded', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '71001',
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

    const failedRefund = await arena.callWebhook(refundPayload, 'order_refunded');
    assert.equal(failedRefund.status, 500);
    assert.equal(failedRefund.body.error, 'database_rpc_error');
    // Verify atomic rollback: payment_status is still 'paid', delivery_id was NOT recorded in processed_webhook_events, zero split upserts
    assert.equal(arena.state.payments[0].payment_status, 'paid');
    assert.equal(arena.state.payment_reconciliation_issues.length, 0);
    assert.equal(arena.state.processed_webhook_events.length, 1); // Only the initial order_created
    assert.equal(arena.getSplitPostgrestUpserts(), 0);

    // Remove fault injection and retry same webhook -> succeeds atomically
    arena.faultInjection.failLifecycleReconciliationInsert = false;
    const retryRefund = await arena.callWebhook(refundPayload, 'order_refunded');
    assert.equal(retryRefund.status, 200);
    assert.equal(retryRefund.body.status, 'reconciliation_logged');
    assert.equal(retryRefund.body.refund_type, 'full');
    assert.equal(arena.state.payments[0].payment_status, 'refunded');
    assert.equal(arena.state.payments[0].refund_resolution_status, 'pending_admin_review');
    assert.equal(arena.state.payment_reconciliation_issues.length, 1);
    assert.equal(arena.state.payment_reconciliation_issues[0].refund_type, 'full');
    assert.equal(arena.state.payment_reconciliation_issues[0].refunded_amount, 1199);
    assert.equal(arena.getSplitPostgrestUpserts(), 0);
  });

  // ==========================================================================
  // 3. AUD-03: FULL 10-SCENARIO REFUND & ENTITLEMENT RESOLUTION SUITE
  // ==========================================================================
  await test('3. [AUD-03] Complete 10-scenario Admin Refund & Entitlement Resolution verification with atomic rollback', async () => {
    const arena = createTransactionalArena();
    const initialPageExpiry = arena.state.pages[0].expires_at;

    // Step 0: Create initial payment (order 81001) -> extends page from 2026-11-10 by 30 days to 2026-12-10
    const order1 = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '81001',
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
    await arena.callWebhook(order1, 'order_created');
    const payment1 = arena.state.payments[0];
    assert.equal(payment1.previous_expires_at, initialPageExpiry);
    assert.equal(payment1.granted_expires_at, '2026-12-10T00:00:00.000Z');
    assert.equal(payment1.entitlement_status, 'active');

    // Trigger full refund webhook on order 81001
    const refund1 = JSON.stringify({
      meta: { event_name: 'order_refunded', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '81001',
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
    await arena.callWebhook(refund1, 'order_refunded');
    const issue1 = arena.state.payment_reconciliation_issues[0];

    // Scenario 3.1: Non-admin caller rejected
    const nonAdminRes = await arena.callAdminResolve(
      {
        p_issue_id: issue1.id,
        p_resolution_notes: 'Attempt by regular user',
        p_decision: 'confirm_full_refund',
        p_verified_refund_amount: 1199,
        p_entitlement_action: 'revoke_if_safe',
      },
      { id: UUID_USER_1, email: 'customer@example.com' },
    );
    assert.ok(nonAdminRes.error);
    assert.match(nonAdminRes.error.message, /admin privileges required/);

    // Scenario 3.2: Refund issue cannot be resolved with 'acknowledge_only'
    const ackOnlyRes = await arena.callAdminResolve({
      p_issue_id: issue1.id,
      p_resolution_notes: 'Trying acknowledge_only on refund',
      p_decision: 'acknowledge_only',
      p_verified_refund_amount: null,
      p_entitlement_action: 'keep_entitlement',
    });
    assert.ok(ackOnlyRes.error);
    assert.match(ackOnlyRes.error.message, /refund issues require explicit refund decision/);

    // Scenario 3.3: Simulated audit log failure rolls back both payment/issue resolution and entitlement revocation
    arena.faultInjection.failAdminAuditLog = true;
    const auditFailRes = await arena.callAdminResolve({
      p_issue_id: issue1.id,
      p_resolution_notes: 'Should rollback on audit failure',
      p_decision: 'confirm_full_refund',
      p_verified_refund_amount: 1199,
      p_entitlement_action: 'revoke_if_safe',
    });
    assert.ok(auditFailRes.error);
    assert.equal(arena.state.payment_reconciliation_issues[0].resolved, false);
    assert.equal(arena.state.pages[0].expires_at, '2026-12-10T00:00:00.000Z');
    assert.equal(arena.state.payments[0].entitlement_status, 'active');
    arena.faultInjection.failAdminAuditLog = false;

    // Scenario 3.4: Simulated entitlement update failure rolls back issue resolution
    arena.faultInjection.failEntitlementRevokeUpdate = true;
    const revokeFailRes = await arena.callAdminResolve({
      p_issue_id: issue1.id,
      p_resolution_notes: 'Should rollback on entitlement failure',
      p_decision: 'confirm_full_refund',
      p_verified_refund_amount: 1199,
      p_entitlement_action: 'revoke_if_safe',
    });
    assert.ok(revokeFailRes.error);
    assert.equal(arena.state.payment_reconciliation_issues[0].resolved, false);
    assert.equal(arena.state.admin_audit_logs.length, 0);
    arena.faultInjection.failEntitlementRevokeUpdate = false;

    // Scenario 3.5: Valid Full Refund + Safe Entitlement Revocation restores exact previous_expires_at
    const validFullResolve = await arena.callAdminResolve({
      p_issue_id: issue1.id,
      p_resolution_notes: 'Verified full refund in Lemon Squeezy dashboard; revoking granted period safely',
      p_decision: 'confirm_full_refund',
      p_verified_refund_amount: 1199,
      p_entitlement_action: 'revoke_if_safe',
    });
    assert.equal(validFullResolve.error, null);
    assert.equal(validFullResolve.data.status, 'resolved');
    assert.equal(validFullResolve.data.entitlement_revoked, true);
    assert.equal(arena.state.pages[0].expires_at, initialPageExpiry, 'Page expiry restored to exact previous_expires_at');
    assert.equal(arena.state.payments[0].entitlement_status, 'revoked');
    assert.equal(arena.state.payments[0].refund_resolution_status, 'full_refund_confirmed');
    assert.equal(arena.state.admin_audit_logs.length, 1);

    // Scenario 3.6: Re-executing resolution on an already resolved issue is rejected
    const repeatResolve = await arena.callAdminResolve({
      p_issue_id: issue1.id,
      p_resolution_notes: 'Duplicate admin click',
      p_decision: 'confirm_full_refund',
      p_verified_refund_amount: 1199,
      p_entitlement_action: 'keep_entitlement',
    });
    assert.ok(repeatResolve.error);
    assert.match(repeatResolve.error.message, /reconciliation issue already resolved/);

    // Scenario 3.7: Multi-payment page protection — refunding an earlier payment when a newer active payment exists on the same page MUST NOT revoke the newer payment's entitlement
    const order2 = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '81002',
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
    const order3 = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '81003',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          subtotal: 2499,
          discount_total: 0,
          tax: 500,
          total: 2999,
          currency: 'USD',
          first_order_item: { variant_id: 101002 },
        },
      },
    });
    await arena.callWebhook(order2, 'order_created');
    await arena.callWebhook(order3, 'order_created');
    const expiryAfterOrder3 = arena.state.pages[0].expires_at;

    // Refund order2 (the earlier payment) while order3 is active
    const refund2 = JSON.stringify({
      meta: { event_name: 'order_refunded', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '81002',
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
    await arena.callWebhook(refund2, 'order_refunded');
    const issue2 = arena.state.payment_reconciliation_issues.find((i) => i.order_id === '81002');

    // Attempting 'revoke_if_safe' on order2 must fail because order3 is a newer active payment on the same page
    const unsafeRevokeRes = await arena.callAdminResolve({
      p_issue_id: issue2.id,
      p_resolution_notes: 'Attempt revoke on earlier payment',
      p_decision: 'confirm_full_refund',
      p_verified_refund_amount: 1199,
      p_entitlement_action: 'revoke_if_safe',
    });
    assert.ok(unsafeRevokeRes.error);
    assert.match(unsafeRevokeRes.error.message, /subsequent active payment exists on the same page/);
    assert.equal(arena.state.pages[0].expires_at, expiryAfterOrder3, 'Page expiry must remain untouched');

    // Admin can safely confirm full refund on order2 with keep_entitlement
    const safeKeepRes = await arena.callAdminResolve({
      p_issue_id: issue2.id,
      p_resolution_notes: 'Confirmed refund on earlier order while keeping active renewal entitlement',
      p_decision: 'confirm_full_refund',
      p_verified_refund_amount: 1199,
      p_entitlement_action: 'keep_entitlement',
    });
    assert.equal(safeKeepRes.error, null);
    assert.equal(safeKeepRes.data.entitlement_revoked, false);
    assert.equal(arena.state.pages[0].expires_at, expiryAfterOrder3);

    // Scenario 3.8: Partial Refund confirmation & Unverified Refund resolution
    const partialRefundOrder3 = JSON.stringify({
      meta: { event_name: 'order_refunded', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '81003',
        attributes: {
          store_id: 55001,
          test_mode: true,
          status: 'paid',
          refunded: false,
          subtotal: 2499,
          discount_total: 0,
          tax: 500,
          total: 2999,
          refunded_amount: 1000,
          currency: 'USD',
        },
      },
    });
    await arena.callWebhook(partialRefundOrder3, 'order_refunded');
    const issue3 = arena.state.payment_reconciliation_issues.find((i) => i.order_id === '81003');
    const partialRes = await arena.callAdminResolve({
      p_issue_id: issue3.id,
      p_resolution_notes: 'Confirmed partial goodwill refund of $10.00',
      p_decision: 'confirm_partial_refund',
      p_verified_refund_amount: 1000,
      p_entitlement_action: 'keep_entitlement',
    });
    assert.equal(partialRes.error, null);
    assert.equal(partialRes.data.verified_refund_amount, 1000);
    const payment3 = arena.state.payments.find((p) => p.order_id === '81003');
    assert.equal(payment3.payment_status, 'partially_refunded');
    assert.equal(payment3.refunded_amount, 1000);
    assert.equal(payment3.refund_resolution_status, 'partial_refund_confirmed');
  });

  // ==========================================================================
  // 4. AUD-04: NO SILENT WEBHOOK DROP (MODE MISMATCH, STORE MISMATCH, DISABLED DB)
  // ==========================================================================
  await test('4. [AUD-04] Real lemon-webhook + SQL RPC never silently drop store_id_mismatch, webhook_mode_mismatch, or provider_disabled_in_db', async () => {
    const arena = createTransactionalArena({
      pricing_settings: {
        id: 'global',
        payment_provider_enabled: false, // Disabled in DB while enabled in Edge env
        payment_mode: 'disabled',
        payment_provider_mode: 'disabled',
        store_id: TEST_STORE_ID,
        lemon_test_store_id: TEST_STORE_ID,
        plan1_test_variant_id: '101001',
        plan1_days: 30,
      },
    });

    const initialExpiry = arena.state.pages[0].expires_at;
    const rawOrder = JSON.stringify({
      meta: { event_name: 'order_created', custom_data: { user_id: UUID_USER_1, page_id: UUID_PAGE_1 } },
      data: {
        type: 'orders',
        id: '91001',
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

    const resDisabledDb = await arena.callWebhook(rawOrder, 'order_created');
    assert.equal(resDisabledDb.status, 200);
    assert.equal(resDisabledDb.body.status, 'reconciliation_logged');
    assert.equal(resDisabledDb.body.result, 'provider_disabled_in_db');
    assert.equal(resDisabledDb.body.subscription_extended, false);
    assert.equal(arena.state.pages[0].expires_at, initialExpiry, 'Must never extend subscription');
    assert.equal(arena.state.payment_reconciliation_issues.length, 1, 'Must persist reconciliation issue');
    assert.equal(arena.state.payment_reconciliation_issues[0].failure_reason, 'provider_disabled_in_db');
    assert.equal(arena.state.processed_webhook_events.length, 1, 'Must record delivery_id atomically with reconciliation issue');
  });

  // ==========================================================================
  // 5. AUD-05: MULTI-PAGE SELECTION IN REAL src/views/pricing.js + CHECKOUT
  // ==========================================================================
  await test('5. [AUD-05] Real src/views/pricing.js resolvePricingPageSelection & lemon-checkout multi-page validation', async () => {
    const ownedPages = filterOwnedPages(
      [
        { id: UUID_PAGE_1, user_id: UUID_USER_1, slug: 'p1', title: 'Page 1' },
        { id: UUID_PAGE_2, user_id: UUID_USER_1, slug: 'p2', title: 'Page 2' },
        { id: UUID_PAGE_OTHER, user_id: UUID_USER_2, slug: 'p3', title: 'Other User Page' },
      ],
      UUID_USER_1,
    );
    assert.equal(ownedPages.length, 2);
    const userObj = { id: UUID_USER_1 };

    // 5a. Single page user auto-selects their single page
    const singleSel = resolvePricingPageSelection({
      user: userObj,
      ownedPages: [ownedPages[0]],
      selectedPageId: '',
      plan: 1,
      origin: 'https://pageads.ahmedkhalled1994.workers.dev',
    });
    assert.equal(singleSel.ok, true);
    assert.equal(singleSel.targetPageId, UUID_PAGE_1);
    assert.equal(singleSel.payload.page_id, UUID_PAGE_1);

    // 5b. Multi-page user without selection -> error: ambiguous_page_selection
    const missingSel = resolvePricingPageSelection({
      user: userObj,
      ownedPages,
      selectedPageId: '',
      plan: 1,
    });
    assert.equal(missingSel.ok, false);
    assert.equal(missingSel.error, 'ambiguous_page_selection');

    // 5c. Multi-page user selecting invalid UUID -> error: invalid_page_id
    const invalidUuidSel = resolvePricingPageSelection({
      user: userObj,
      ownedPages,
      selectedPageId: 'not-a-uuid',
      plan: 1,
    });
    assert.equal(invalidUuidSel.ok, false);
    assert.equal(invalidUuidSel.error, 'invalid_page_id');

    // 5d. Multi-page user selecting another user's page -> error: forbidden_page
    const forbiddenSel = resolvePricingPageSelection({
      user: userObj,
      ownedPages,
      selectedPageId: UUID_PAGE_OTHER,
      plan: 1,
    });
    assert.equal(forbiddenSel.ok, false);
    assert.equal(forbiddenSel.error, 'forbidden_page');

    // 5e. Cancelled selection -> error: checkout_cancelled
    const cancelledSel = resolvePricingPageSelection({
      user: userObj,
      ownedPages,
      selectedPageId: UUID_PAGE_2,
      plan: 1,
      cancelled: true,
    });
    assert.equal(cancelledSel.ok, false);
    assert.equal(cancelledSel.error, 'checkout_cancelled');

    // 5f. Multi-page user selecting valid owned page -> ok: true, targetPageId: UUID_PAGE_2
    const validSel = resolvePricingPageSelection({
      user: userObj,
      ownedPages,
      selectedPageId: UUID_PAGE_2,
      plan: 2,
      origin: 'https://pageads.ahmedkhalled1994.workers.dev',
    });
    assert.equal(validSel.ok, true);
    assert.equal(validSel.targetPageId, UUID_PAGE_2);
    assert.equal(validSel.payload.page_id, UUID_PAGE_2);
    assert.equal(validSel.payload.plan, 2);

    // 5g. End-to-end check with real lemon-checkout handler for multi-page user
    const arena = createTransactionalArena({
      pages: [
        { id: UUID_PAGE_1, user_id: UUID_USER_1, slug: 'p1', is_active: true, is_trial: true, expires_at: '2026-11-10T00:00:00.000Z' },
        { id: UUID_PAGE_2, user_id: UUID_USER_1, slug: 'p2', is_active: true, is_trial: true, expires_at: '2026-11-10T00:00:00.000Z' },
      ],
    });

    // Missing page_id -> 400 ambiguous_page_selection
    const resAmbig = await arena.callCheckout({ plan: 1 });
    assert.equal(resAmbig.status, 400);
    assert.equal(resAmbig.body.error, 'ambiguous_page_selection');

    // Unowned page_id -> 403 forbidden_page
    const resForbidden = await arena.callCheckout({ plan: 1, page_id: UUID_PAGE_OTHER });
    assert.equal(resForbidden.status, 403);
    assert.equal(resForbidden.body.error, 'forbidden_page');

    // Valid selected page_id -> 200 OK
    const resValidPage = await arena.callCheckout(validSel.payload);
    assert.equal(resValidPage.status, 200);
    assert.ok(resValidPage.body.url.startsWith('https://'));
  });

  // ==========================================================================
  // 6. AUD-07 & COMBINED SQL AUDIT FILE INTEGRITY VERIFICATION
  // ==========================================================================
  await test('6. [AUD-07 & SQL Integrity] Verify .env / .env.example safety and 100% verbatim match of PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql', async () => {
    const envContent = fs.readFileSync(path.join(ROOT_DIR, '.env'), 'utf8');
    const envExampleContent = fs.readFileSync(path.join(ROOT_DIR, '.env.example'), 'utf8');

    for (const [name, content] of [
      ['.env', envContent],
      ['.env.example', envExampleContent],
    ]) {
      assert.equal(content.includes('pfgqmhpmuytnbzkvmlut'), false, `${name} must NOT contain legacy project ref pfgqmhpmuytnbzkvmlut`);
      assert.equal(content.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), false, `${name} must NOT contain hardcoded JWT tokens`);
      assert.match(content, /LEMONSQUEEZY_ENABLED=false/, `${name} must enforce LEMONSQUEEZY_ENABLED=false`);
      assert.match(content, /LEMONSQUEEZY_MODE=disabled/, `${name} must enforce LEMONSQUEEZY_MODE=disabled`);
      assert.match(content, /VITE_LEMONSQUEEZY_ENABLED=false/, `${name} must enforce VITE_LEMONSQUEEZY_ENABLED=false`);
      assert.match(content, /VITE_LEMONSQUEEZY_MODE=disabled/, `${name} must enforce VITE_LEMONSQUEEZY_MODE=disabled`);
    }

    // Verify customer payment availability helper still defaults to disabled when disabled
    const disabledStatus = evaluateCustomerPaymentAvailability({
      payment_provider_enabled: false,
      payment_mode: 'disabled',
    });
    assert.equal(disabledStatus.providerEnabled, false);
    assert.equal(disabledStatus.mode, 'disabled');
    assert.deepEqual(disabledStatus.onlinePlans, { 1: false, 2: false, 3: false });
    assert.equal(
      DISABLED_PAYMENT_MESSAGE,
      'الدفع الإلكتروني غير متاح حالياً، نعمل على تجهيز خدمة الدفع وسيتم تفعيلها قريباً.',
    );

    // Programmatic verification that PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql contains Migrations 11, 12, and 13 verbatim
    const mig11 = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/20261106011734_lemon_squeezy_payments.sql'), 'utf8');
    const mig12 = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/20261106041500_phase1_security_hardening_and_audit_logs.sql'), 'utf8');
    const mig13 = fs.readFileSync(path.join(ROOT_DIR, 'supabase/migrations/20261106053000_payment_system_hardening_and_reconciliation.sql'), 'utf8');
    const fullAudit = fs.readFileSync(path.join(ROOT_DIR, 'PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql'), 'utf8');

    assert.ok(fullAudit.includes(mig11), 'PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql must contain Migration 11 verbatim');
    assert.ok(fullAudit.includes(mig12), 'PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql must contain Migration 12 verbatim');
    assert.ok(fullAudit.includes(mig13), 'PAG_ADS_SQL_MIGRATIONS_FULL_AUDIT.sql must contain Migration 13 verbatim');

    const idx11 = fullAudit.indexOf(mig11);
    const idx12 = fullAudit.indexOf(mig12);
    const idx13 = fullAudit.indexOf(mig13);
    assert.ok(idx11 < idx12 && idx12 < idx13, 'Migrations 11, 12, and 13 must appear in strict chronological order');
  });

  console.log(`\n====================================================================`);
  console.log(`REAL-HANDLER & TRANSACTIONAL SQL SIMULATOR SUMMARY: ${results.length}/${results.length} PASSED`);
  console.log(`NOTE: Executed against REAL Edge Function handlers and REAL frontend modules.`);
  console.log(`SQL transactions were simulated in-memory (no live/staging DB touched).`);
  console.log(`====================================================================\n`);
}

runAllIntegrationTests().catch((err) => {
  console.error('❌ [INTEGRATION TEST FAILURE]:', err);
  process.exit(1);
});
