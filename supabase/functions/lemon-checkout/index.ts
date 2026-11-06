import { createClient } from "npm:@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const PLAN_NUMBERS = [1, 2, 3] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIANT_ID_REGEX = /^\d{1,20}$/;
const STORE_ID_REGEX = /^\d{1,20}$/;
const CHECKOUT_TIMEOUT_MS = 12_000;
const MAX_CHECKOUT_BODY_BYTES = 16 * 1024; // 16 KB
const MAX_LEMON_RESPONSE_BYTES = 64 * 1024; // 64 KB
const USER_RATE_LIMIT_WINDOW_MS = 60_000;
const USER_RATE_LIMIT_MAX_REQUESTS = 5;

const FORBIDDEN_CLIENT_OVERRIDE_KEYS = [
  "price",
  "custom_price",
  "amount",
  "days",
  "days_added",
  "variant_id",
  "test_variant_id",
  "mode",
  "payment_mode",
  "user_id",
  "store_id",
  "test_mode",
  "currency",
  "variant_currency",
] as const;

const ALLOWED_CHECKOUT_BODY_KEYS = new Set([
  "action",
  "plan",
  "page_id",
  "origin",
]);

const DEFAULT_TRUSTED_ORIGINS = [
  "https://pageads.ahmedkhalled1994.workers.dev",
  "https://ais-dev-elow2pgon3diltn3hthovi-718657541875.europe-west1.run.app",
  "https://ais-pre-elow2pgon3diltn3hthovi-718657541875.europe-west1.run.app",
  "https://sbrzxvujrylyohmybddj.supabase.co",
];

// Officially documented Lemon Squeezy checkout custom_price minor-unit exponents
// Per Lemon Squeezy Create a Checkout docs:
// "A positive integer in cents representing the custom price of the variant.
//  Note: for zero-decimal currencies, the value should still be in the currency's smallest unit
//  (e.g. 599 represents $5.99 for USD or ¥599 for JPY)."
const DOCUMENTED_CHECKOUT_CURRENCY_EXPONENTS: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

// Isolate-level concurrency & rate-limit guards (complemented by DB RPC check_checkout_rate_limit)
const ACTIVE_USER_CHECKOUTS = new Set<string>();
const USER_CHECKOUT_TIMESTAMPS = new Map<string, number[]>();

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function normalizeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

function getCurrencyExponent(currencyCode: string): number {
  const code = String(currencyCode || "").trim().toUpperCase();
  if (Object.prototype.hasOwnProperty.call(DOCUMENTED_CHECKOUT_CURRENCY_EXPONENTS, code)) {
    return DOCUMENTED_CHECKOUT_CURRENCY_EXPONENTS[code];
  }
  return -1;
}

/**
 * Extracts explicit currency code from a plan price string.
 * NEVER guesses or defaults to USD when no explicit currency token is present.
 */
function detectCurrencyFromPriceString(rawPrice: string): string | null {
  const normalized = String(rawPrice || "").trim();
  if (!normalized) return null;

  const upper = normalized.toUpperCase();
  const detectedCodes = new Set<string>();

  if (/\bKWD\b|د\.?\s*ك|دينار\s*كويتي|دينار|دنانير/i.test(normalized)) detectedCodes.add("KWD");
  if (/\bSAR\b|ر\.?\s*س|ريال\s*سعودي/i.test(normalized)) detectedCodes.add("SAR");
  if (/\bAED\b|د\.?\s*إ|درهم/i.test(normalized)) detectedCodes.add("AED");
  if (/\bQAR\b|ر\.?\s*ق|ريال\s*قطري/i.test(normalized)) detectedCodes.add("QAR");
  if (/\bBHD\b|د\.?\s*ب|دينار\s*بحريني/i.test(normalized)) detectedCodes.add("BHD");
  if (/\bOMR\b|ر\.?\s*ع|ريال\s*عماني/i.test(normalized)) detectedCodes.add("OMR");
  if (/\bEGP\b|ج\.?\s*م|جنيه/i.test(normalized)) detectedCodes.add("EGP");
  if (/\bEUR\b|€/.test(upper)) detectedCodes.add("EUR");
  if (/\bGBP\b|£/.test(upper)) detectedCodes.add("GBP");
  if (/\bJPY\b|¥/.test(upper)) detectedCodes.add("JPY");
  if (/\bCAD\b|CA\$|C\$/i.test(normalized)) detectedCodes.add("CAD");
  if (/\bAUD\b|AU\$|A\$/i.test(normalized)) detectedCodes.add("AUD");

  if (!detectedCodes.has("CAD") && !detectedCodes.has("AUD")) {
    if (/\bUSD\b|US\$|\$|دولار/i.test(normalized)) {
      detectedCodes.add("USD");
    }
  }

  const isoMatches = upper.match(/\b[A-Z]{3}\b/g) || [];
  for (const iso of isoMatches) {
    detectedCodes.add(iso);
  }

  // Reject if no explicit currency was found or if multiple conflicting currencies appear
  if (detectedCodes.size !== 1) {
    return null;
  }

  return [...detectedCodes][0];
}

/**
 * Parses a human-readable plan price string into integer minor units without floating-point math.
 * Rejects:
 * - Missing explicit currency
 * - Undocumented currencies (e.g. KWD, SAR)
 * - Negative signs, multiple numbers, or ambiguous thousand/decimal separators
 * - Zero amounts or fractional precision exceeding the currency's exponent
 */
function parsePriceToMinorUnits(
  rawPrice: string,
): {
  ok: boolean;
  minorUnits: number;
  currency: string;
  documentedCurrency: boolean;
  error?: string;
} {
  const normalized = normalizeDigits(String(rawPrice || "")).trim();
  if (!normalized) {
    return { ok: false, minorUnits: 0, currency: "", documentedCurrency: false, error: "empty_price" };
  }

  // Reject negative signs or range hyphens between numbers
  if (/-/.test(normalized)) {
    return { ok: false, minorUnits: 0, currency: "", documentedCurrency: false, error: "negative_or_range_price" };
  }

  const currency = detectCurrencyFromPriceString(normalized);
  if (!currency) {
    return {
      ok: false,
      minorUnits: 0,
      currency: "",
      documentedCurrency: false,
      error: "missing_or_ambiguous_currency",
    };
  }

  const documentedCurrency = Object.prototype.hasOwnProperty.call(
    DOCUMENTED_CHECKOUT_CURRENCY_EXPONENTS,
    currency,
  );
  if (!documentedCurrency) {
    return {
      ok: false,
      minorUnits: 0,
      currency,
      documentedCurrency: false,
      error: "unverified_checkout_currency",
    };
  }

  const exponent = getCurrencyExponent(currency);

  // Extract all numeric tokens (including any separators)
  const numericTokens = normalized.match(/\d+(?:[.,]\d+)*/g);
  if (!numericTokens || numericTokens.length !== 1) {
    return {
      ok: false,
      minorUnits: 0,
      currency,
      documentedCurrency,
      error: "ambiguous_multiple_numbers",
    };
  }

  const token = numericTokens[0];

  // Forbid multiple separators or mixed comma + dot separators (e.g. "1,234.56" or "1,000,000")
  const separatorMatches = token.match(/[.,]/g) || [];
  if (separatorMatches.length > 1) {
    return {
      ok: false,
      minorUnits: 0,
      currency,
      documentedCurrency,
      error: "ambiguous_number_separators",
    };
  }

  // Forbid comma with 3 trailing digits (ambiguous thousand separator vs decimal, e.g. "1,234")
  if (token.includes(",")) {
    return {
      ok: false,
      minorUnits: 0,
      currency,
      documentedCurrency,
      error: "ambiguous_comma_separator",
    };
  }

  const parts = token.split(".");
  const wholePartStr = parts[0] || "0";
  const fracPartStr = parts[1] || "";

  if (!/^\d+$/.test(wholePartStr) || (fracPartStr !== "" && !/^\d+$/.test(fracPartStr))) {
    return { ok: false, minorUnits: 0, currency, documentedCurrency, error: "invalid_digits" };
  }

  if (fracPartStr.length > exponent) {
    return {
      ok: false,
      minorUnits: 0,
      currency,
      documentedCurrency,
      error: "fractional_precision_exceeds_currency_exponent",
    };
  }

  const paddedFrac = fracPartStr.padEnd(exponent, "0");
  const combinedDigits = `${wholePartStr}${paddedFrac}`.replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(combinedDigits) || combinedDigits.length > 12) {
    return { ok: false, minorUnits: 0, currency, documentedCurrency, error: "amount_out_of_bounds" };
  }

  const minorUnits = Number(combinedDigits);
  if (!Number.isSafeInteger(minorUnits) || minorUnits <= 0) {
    return { ok: false, minorUnits: 0, currency, documentedCurrency, error: "non_positive_amount" };
  }

  return { ok: true, minorUnits, currency, documentedCurrency: true };
}

function buildTrustedOriginsSet(effectiveMode: "test" | "live"): Set<string> {
  const allowed = new Set<string>(DEFAULT_TRUSTED_ORIGINS);
  const envOrigins = String(Deno.env.get("ALLOWED_CHECKOUT_ORIGINS") || "").trim();
  if (envOrigins) {
    for (const item of envOrigins.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      try {
        const parsed = new URL(trimmed);
        if (parsed.protocol === "https:" && !parsed.username && !parsed.password) {
          allowed.add(parsed.origin);
        }
      } catch {
        // Ignore malformed env entry
      }
    }
  }
  const supaUrl = String(Deno.env.get("SUPABASE_URL") || "").trim();
  if (supaUrl) {
    try {
      const parsed = new URL(supaUrl);
      if (parsed.protocol === "https:") {
        allowed.add(parsed.origin);
      }
    } catch {
      // Ignore
    }
  }
  if (effectiveMode === "test") {
    allowed.add("http://localhost:3000");
    allowed.add("http://localhost:5173");
    allowed.add("http://127.0.0.1:3000");
    allowed.add("http://127.0.0.1:5173");
  }
  return allowed;
}

function validateTrustedOrigin(
  rawOrigin: unknown,
  effectiveMode: "test" | "live",
): { ok: boolean; origin: string; wasProvided: boolean } {
  const trimmed = typeof rawOrigin === "string" ? rawOrigin.trim() : "";
  if (!trimmed) {
    return { ok: true, origin: "", wasProvided: false };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.username || parsed.password) {
      return { ok: false, origin: "", wasProvided: true };
    }
    if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") {
      return { ok: false, origin: "", wasProvided: true };
    }

    const trustedSet = buildTrustedOriginsSet(effectiveMode);
    if (trustedSet.has(parsed.origin)) {
      return { ok: true, origin: parsed.origin, wasProvided: true };
    }

    if (
      effectiveMode === "test" &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return { ok: true, origin: parsed.origin, wasProvided: true };
    }

    return { ok: false, origin: "", wasProvided: true };
  } catch {
    return { ok: false, origin: "", wasProvided: true };
  }
}

function isValidLemonCheckoutUrl(rawUrl: unknown): rawUrl is string {
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== "https:") return false;
    if (parsed.username || parsed.password) return false;
    const host = parsed.hostname.toLowerCase();
    return host === "lemonsqueezy.com" || host.endsWith(".lemonsqueezy.com");
  } catch {
    return false;
  }
}

async function readBoundedText(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: boolean; text: string; tooLarge?: boolean }> {
  if (!stream) {
    return { ok: true, text: "" };
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          try {
            await reader.cancel();
          } catch {
            // Ignore cancel errors
          }
          return { ok: false, text: "", tooLarge: true };
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(combined) };
}

function resolveProviderModeFromEnv(): {
  enabled: boolean;
  mode: "disabled" | "test" | "live";
  hasInvalidMode: boolean;
} {
  const rawEnabled = String(Deno.env.get("LEMONSQUEEZY_ENABLED") || "false")
    .trim()
    .toLowerCase();
  const rawMode = String(Deno.env.get("LEMONSQUEEZY_MODE") || "disabled")
    .trim()
    .toLowerCase();

  if (rawMode !== "disabled" && rawMode !== "test" && rawMode !== "live") {
    return { enabled: false, mode: "disabled", hasInvalidMode: true };
  }

  const enabled = rawEnabled === "true" && (rawMode === "test" || rawMode === "live");
  return {
    enabled,
    mode: enabled ? (rawMode as "test" | "live") : "disabled",
    hasInvalidMode: false,
  };
}

function normalizeDbMode(rawMode: unknown): "disabled" | "test" | "live" | "invalid" {
  const val = String(rawMode || "disabled").trim().toLowerCase();
  if (val === "disabled" || val === "test" || val === "live") {
    return val;
  }
  return "invalid";
}

/**
 * Resolves mode-specific credentials with ZERO generic fallback.
 * Generic variables (LEMONSQUEEZY_API_KEY, LEMONSQUEEZY_WEBHOOK_SECRET, LEMONSQUEEZY_STORE_ID)
 * are strictly ignored to prevent accidental Test/Live cross-contamination.
 */
function resolveModeSecrets(
  mode: "disabled" | "test" | "live",
  settings: Record<string, unknown>,
): {
  apiKey: string;
  storeId: string;
  webhookSecret: string;
  hasSecretCollision: boolean;
  hasStoreMismatch: boolean;
} {
  const testApiKey = String(Deno.env.get("LEMONSQUEEZY_TEST_API_KEY") || "").trim();
  const liveApiKey = String(Deno.env.get("LEMONSQUEEZY_LIVE_API_KEY") || "").trim();

  const testWebhookSecret = String(Deno.env.get("LEMONSQUEEZY_TEST_WEBHOOK_SECRET") || "").trim();
  const liveWebhookSecret = String(Deno.env.get("LEMONSQUEEZY_LIVE_WEBHOOK_SECRET") || "").trim();

  const testStoreEnv = String(Deno.env.get("LEMONSQUEEZY_TEST_STORE_ID") || "").trim();
  const liveStoreEnv = String(Deno.env.get("LEMONSQUEEZY_LIVE_STORE_ID") || "").trim();

  const dbTestStore = String(settings.lemon_test_store_id || "").trim();
  const dbLiveStore = String(settings.lemon_store_id || settings.store_id || "").trim();

  // Forbid using the same API key, webhook secret, or store ID across Test and Live
  const hasSecretCollision =
    (testApiKey !== "" && liveApiKey !== "" && testApiKey === liveApiKey) ||
    (testWebhookSecret !== "" && liveWebhookSecret !== "" && testWebhookSecret === liveWebhookSecret) ||
    (testStoreEnv !== "" && liveStoreEnv !== "" && testStoreEnv === liveStoreEnv) ||
    (dbTestStore !== "" && dbLiveStore !== "" && dbTestStore === dbLiveStore);

  if (mode === "test") {
    const hasStoreMismatch =
      testStoreEnv !== "" && dbTestStore !== "" && testStoreEnv !== dbTestStore;
    return {
      apiKey: testApiKey,
      storeId: testStoreEnv,
      webhookSecret: testWebhookSecret,
      hasSecretCollision,
      hasStoreMismatch,
    };
  }

  if (mode === "live") {
    const hasStoreMismatch =
      liveStoreEnv !== "" && dbLiveStore !== "" && liveStoreEnv !== dbLiveStore;
    return {
      apiKey: liveApiKey,
      storeId: liveStoreEnv,
      webhookSecret: liveWebhookSecret,
      hasSecretCollision,
      hasStoreMismatch,
    };
  }

  return {
    apiKey: "",
    storeId: "",
    webhookSecret: "",
    hasSecretCollision,
    hasStoreMismatch: false,
  };
}

function hasTestLiveVariantCollision(settings: Record<string, unknown>): boolean {
  const testIds = PLAN_NUMBERS.map((p) => String(settings[`plan${p}_test_variant_id`] || "").trim()).filter(Boolean);
  const liveSet = new Set(
    PLAN_NUMBERS.map((p) => String(settings[`plan${p}_variant_id`] || "").trim()).filter(Boolean),
  );
  return testIds.some((id) => liveSet.has(id));
}

function hasDuplicateModeVariants(settings: Record<string, unknown>, mode: "test" | "live"): boolean {
  const ids = PLAN_NUMBERS.map((p) =>
    mode === "test"
      ? String(settings[`plan${p}_test_variant_id`] || "").trim()
      : String(settings[`plan${p}_variant_id`] || "").trim(),
  ).filter(Boolean);
  return new Set(ids).size !== ids.length;
}

function resolveActiveVariantId(
  settings: Record<string, unknown>,
  plan: 1 | 2 | 3,
  mode: "test" | "live",
): string {
  const key = mode === "test" ? `plan${plan}_test_variant_id` : `plan${plan}_variant_id`;
  return String(settings[key] || "").trim();
}

function checkInMemoryUserRateLimit(userId: string): boolean {
  const now = Date.now();
  const recent = (USER_CHECKOUT_TIMESTAMPS.get(userId) || []).filter(
    (ts) => now - ts < USER_RATE_LIMIT_WINDOW_MS,
  );
  if (recent.length >= USER_RATE_LIMIT_MAX_REQUESTS) {
    USER_CHECKOUT_TIMESTAMPS.set(userId, recent);
    return false;
  }
  recent.push(now);
  USER_CHECKOUT_TIMESTAMPS.set(userId, recent);
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "server_misconfigured" }, 500);
    }

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return json({ error: "unauthorized" }, 401);
    }

    // Enforce bounded request body size before parsing JSON
    const contentLengthHeader = req.headers.get("Content-Length");
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_CHECKOUT_BODY_BYTES) {
        return json({ error: "payload_too_large" }, 413);
      }
    }

    const boundedBody = await readBoundedText(req.body, MAX_CHECKOUT_BODY_BYTES);
    if (!boundedBody.ok) {
      return json({ error: "payload_too_large" }, 413);
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(boundedBody.text);
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    if (typeof parsedBody !== "object" || parsedBody === null || Array.isArray(parsedBody)) {
      return json({ error: "invalid_json_object" }, 400);
    }

    const body = parsedBody as Record<string, unknown>;

    // Block any client attempt to override price, days, variant, mode, user_id, or store_id
    for (const forbiddenKey of FORBIDDEN_CLIENT_OVERRIDE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(body, forbiddenKey)) {
        return json(
          {
            error: "client_override_forbidden",
            field: forbiddenKey,
          },
          400,
        );
      }
    }

    // Reject any unexpected fields outside the strict checkout schema
    for (const key of Object.keys(body)) {
      if (!ALLOWED_CHECKOUT_BODY_KEYS.has(key)) {
        return json(
          {
            error: "unexpected_body_field",
            field: key,
          },
          400,
        );
      }
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);

    if (authErr || !user || !UUID_REGEX.test(user.id)) {
      return json({ error: "unauthorized" }, 401);
    }

    const { data: settings, error: settingsErr } = await supabase
      .from("pricing_settings")
      .select("*")
      .eq("id", "global")
      .maybeSingle();

    if (settingsErr || !settings) {
      return json({ error: "pricing_unavailable" }, 503);
    }

    const envState = resolveProviderModeFromEnv();
    if (envState.hasInvalidMode) {
      return json({ error: "invalid_provider_mode" }, 503);
    }

    const dbEnabled = Boolean(settings.payment_provider_enabled);
    const dbMode = normalizeDbMode(settings.payment_mode || settings.payment_provider_mode || "disabled");
    if (dbMode === "invalid") {
      return json({ error: "invalid_db_payment_mode" }, 503);
    }

    // Enforce strict agreement between Environment and Database modes whenever either is active
    const envActive = envState.enabled && (envState.mode === "test" || envState.mode === "live");
    const dbActive = dbEnabled && (dbMode === "test" || dbMode === "live");
    const hasModeMismatch = envActive && dbActive && envState.mode !== dbMode;

    const effectiveEnabled = envActive && dbActive && !hasModeMismatch;
    const effectiveMode: "disabled" | "test" | "live" = effectiveEnabled ? envState.mode : "disabled";

    const secrets = resolveModeSecrets(
      envActive ? envState.mode : dbActive ? (dbMode as "test" | "live") : "disabled",
      settings,
    );
    const variantCollision = hasTestLiveVariantCollision(settings);
    const duplicateTestVariants = hasDuplicateModeVariants(settings, "test");
    const duplicateLiveVariants = hasDuplicateModeVariants(settings, "live");

    // Admin configuration verification endpoint (`action: "status"`) — strictly Admin Only
    if (body.action === "status") {
      const { data: adminRow, error: adminErr } = await supabase
        .from("admin_users")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();

      if (adminErr) {
        return json({ error: "admin_verification_failed" }, 500);
      }
      if (!adminRow) {
        return json({ error: "forbidden", message: "صلاحية المدير مطلوبة لفحص حالة الربط" }, 403);
      }

      const activeCheckMode = effectiveMode === "test" || effectiveMode === "live" ? effectiveMode : null;
      const allActiveVariantsConfigured = activeCheckMode
        ? PLAN_NUMBERS.every((p) =>
            VARIANT_ID_REGEX.test(resolveActiveVariantId(settings, p, activeCheckMode)),
          )
        : false;
      const duplicateVariantsInActiveMode = activeCheckMode
        ? hasDuplicateModeVariants(settings, activeCheckMode)
        : duplicateTestVariants || duplicateLiveVariants;

      const hasApiKey = secrets.apiKey.length >= 16;
      const hasValidStoreId = STORE_ID_REGEX.test(secrets.storeId) && !secrets.hasStoreMismatch;
      const hasWebhookSecret = secrets.webhookSecret.length >= 16;

      let computedStatus = "disabled";
      let webhookStatus = "disabled";
      let reason = "ok";

      if (hasModeMismatch) {
        computedStatus = "awaiting_credentials";
        webhookStatus = "pending_secret";
        reason = "mode_configuration_mismatch";
      } else if (!effectiveEnabled || effectiveMode === "disabled") {
        computedStatus = "disabled";
        webhookStatus = "disabled";
        reason = "provider_disabled";
      } else if (
        secrets.hasSecretCollision ||
        secrets.hasStoreMismatch ||
        variantCollision ||
        duplicateVariantsInActiveMode ||
        !hasApiKey ||
        !hasValidStoreId ||
        !hasWebhookSecret ||
        !allActiveVariantsConfigured
      ) {
        computedStatus = "awaiting_credentials";
        webhookStatus = hasWebhookSecret ? "test_ready" : "pending_secret";
        reason = secrets.hasSecretCollision
          ? "test_live_secret_collision"
          : secrets.hasStoreMismatch
            ? "store_id_mismatch"
            : variantCollision
              ? "test_live_variant_collision"
              : duplicateVariantsInActiveMode
                ? "duplicate_variant_id"
                : !hasApiKey
                  ? "missing_api_key"
                  : !hasValidStoreId
                    ? "missing_store_id"
                    : !hasWebhookSecret
                      ? "missing_webhook_secret"
                      : "missing_variant_id";
      } else if (effectiveMode === "test") {
        computedStatus = "test_mode";
        webhookStatus = "test_ready";
      } else if (effectiveMode === "live") {
        computedStatus = "live_connected";
        webhookStatus = "verified_live";
      }

      const checkedAt = new Date().toISOString();
      const { error: updateErr } = await supabase
        .from("pricing_settings")
        .update({
          last_config_check_at: checkedAt,
          last_config_check_status: computedStatus,
          webhook_status: webhookStatus,
        })
        .eq("id", "global");

      if (updateErr) {
        return json({ error: "settings_status_update_failed" }, 500);
      }

      return json({
        status: computedStatus,
        mode: effectiveMode,
        enabled: effectiveEnabled,
        webhook_status: webhookStatus,
        has_api_key: hasApiKey,
        has_store_id: hasValidStoreId,
        has_webhook_secret: hasWebhookSecret,
        all_variants_configured: allActiveVariantsConfigured,
        variant_collision: variantCollision,
        duplicate_variants: duplicateVariantsInActiveMode,
        secret_collision: secrets.hasSecretCollision,
        store_mismatch: secrets.hasStoreMismatch,
        mode_mismatch: hasModeMismatch,
        reason,
        checked_at: checkedAt,
      });
    }

    if (hasModeMismatch) {
      return json(
        {
          error: "mode_configuration_mismatch",
          message: "يوجد تعارض بين وضع الدفع في الخادم وقاعدة البيانات. تم إيقاف العملية لحماية الحساب.",
        },
        503,
      );
    }

    if (!effectiveEnabled || effectiveMode === "disabled") {
      return json(
        {
          error: "provider_disabled",
          mode: "disabled",
          message:
            "الدفع الإلكتروني غير متاح حالياً، نعمل على تجهيز خدمة الدفع وسيتم تفعيلها قريباً.",
        },
        503,
      );
    }

    if (secrets.hasSecretCollision) {
      return json(
        {
          error: "test_live_secret_collision",
          message: "لا يجوز استخدام نفس مفاتيح الربط أو المتجر بين الوضع الاختباري والوضع المباشر.",
        },
        503,
      );
    }

    if (secrets.hasStoreMismatch) {
      return json(
        {
          error: "store_id_mismatch",
          message: "معرف المتجر في إعدادات الخادم لا يطابق معرف المتجر في قاعدة البيانات.",
        },
        503,
      );
    }

    if (variantCollision) {
      return json(
        {
          error: "test_live_variant_collision",
          message: "لا يجوز استخدام نفس معرف الباقة (Variant ID) في الوضع الاختباري والوضع المباشر.",
        },
        503,
      );
    }

    if (hasDuplicateModeVariants(settings, effectiveMode)) {
      return json(
        {
          error: "duplicate_variant_id",
          message: "لا يجوز تكرار نفس معرف الباقة (Variant ID) لأكثر من باقة داخل نفس الوضع.",
        },
        503,
      );
    }

    const plan = Number(body.plan);
    if (!Number.isInteger(plan) || !PLAN_NUMBERS.includes(plan as 1 | 2 | 3)) {
      return json({ error: "invalid_plan" }, 400);
    }

    if (!secrets.apiKey) {
      return json({ error: "missing_api_key" }, 503);
    }

    if (!STORE_ID_REGEX.test(secrets.storeId)) {
      return json({ error: "missing_store_id" }, 503);
    }

    if (!secrets.webhookSecret || secrets.webhookSecret.length < 16) {
      return json(
        {
          error: "missing_webhook_secret",
          message: "مفتاح التحقق من إشعارات الدفع (Webhook Secret) غير مهيأ لوضع التشغيل الحالي. تم إيقاف إنشاء جلسة الدفع لحماية الحساب.",
        },
        503,
      );
    }

    // Require all 3 plans in the active mode to have valid numeric Variant IDs
    const variantId = resolveActiveVariantId(settings, plan as 1 | 2 | 3, effectiveMode);
    if (!VARIANT_ID_REGEX.test(variantId)) {
      return json({ error: "missing_variant_id" }, 503);
    }
    const allPlansConfigured = PLAN_NUMBERS.every((p) =>
      VARIANT_ID_REGEX.test(resolveActiveVariantId(settings, p, effectiveMode)),
    );
    if (!allPlansConfigured) {
      return json({ error: "incomplete_plan_variants" }, 503);
    }

    const days = Number(settings[`plan${plan}_days`]);
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      return json({ error: "invalid_plan_days" }, 503);
    }

    const rawPriceString = String(settings[`plan${plan}_new_price`] || "");
    const parsedPrice = parsePriceToMinorUnits(rawPriceString);
    if (!parsedPrice.ok || parsedPrice.minorUnits <= 0 || !parsedPrice.documentedCurrency) {
      return json(
        {
          error:
            parsedPrice.error === "unverified_checkout_currency"
              ? "unverified_checkout_currency"
              : "invalid_plan_price",
          reason: parsedPrice.error || "invalid_plan_price",
        },
        503,
      );
    }

    // Verify that the parsed plan price currency matches the configured Variant Currency
    const expectedVariantCurrency = String(
      Deno.env.get("LEMONSQUEEZY_VARIANT_CURRENCY") || settings.variant_currency || "",
    )
      .trim()
      .toUpperCase();

    if (expectedVariantCurrency && parsedPrice.currency !== expectedVariantCurrency) {
      return json(
        {
          error: "variant_currency_mismatch",
          expected_currency: expectedVariantCurrency,
          plan_currency: parsedPrice.currency,
        },
        503,
      );
    }

    // Validate Origin against strict allowlist before proceeding
    const explicitOriginInput = body.origin !== undefined ? body.origin : req.headers.get("origin");
    const originValidation = validateTrustedOrigin(explicitOriginInput, effectiveMode);
    if (!originValidation.ok) {
      return json({ error: "untrusted_origin" }, 400);
    }

    // Resolve and strictly verify customer's page ownership and status
    const requestedPageId = typeof body.page_id === "string" ? body.page_id.trim() : "";
    if (requestedPageId && !UUID_REGEX.test(requestedPageId)) {
      return json({ error: "invalid_page_id" }, 400);
    }

    const { data: userPages, error: pageErr } = await supabase
      .from("pages")
      .select("id, user_id, is_active")
      .eq("user_id", user.id);

    if (pageErr) {
      return json({ error: "page_lookup_failed" }, 500);
    }

    const ownedPages = Array.isArray(userPages)
      ? userPages.filter((p) => p && p.user_id === user.id && UUID_REGEX.test(String(p.id || "")))
      : [];

    let targetPageId = "";
    if (requestedPageId) {
      const matched = ownedPages.find((p) => p.id === requestedPageId);
      if (!matched) {
        return json({ error: "forbidden_page" }, 403);
      }
      targetPageId = matched.id;
    } else {
      if (ownedPages.length === 0) {
        return json({ error: "no_page" }, 400);
      }
      if (ownedPages.length > 1) {
        return json(
          {
            error: "ambiguous_page_selection",
            message: "يرجى تحديد الصفحة المراد تجديد اشتراكها.",
          },
          400,
        );
      }
      targetPageId = ownedPages[0].id;
    }

    // Prevent concurrent checkout creation and enforce per-user rate limit
    if (ACTIVE_USER_CHECKOUTS.has(user.id)) {
      return json({ error: "concurrent_checkout_in_progress" }, 429);
    }

    if (!checkInMemoryUserRateLimit(user.id)) {
      return json({ error: "rate_limit_exceeded" }, 429);
    }

    ACTIVE_USER_CHECKOUTS.add(user.id);
    try {
      // Mandatory fail-closed DB-backed rate limit & ban verification RPC
      let rlData: unknown = null;
      let rlError: { message?: string } | null = null;
      try {
        const rpcRes = await supabase.rpc("check_checkout_rate_limit", {
          p_user_id: user.id,
          p_page_id: targetPageId,
        });
        rlData = rpcRes?.data ?? null;
        rlError = rpcRes?.error ?? null;
      } catch (rpcException) {
        console.error(
          "Exception during check_checkout_rate_limit RPC:",
          rpcException instanceof Error ? rpcException.message : "unknown_rpc_exception",
        );
        return json({ error: "security_verification_failed" }, 500);
      }

      if (rlError) {
        console.error(
          "Database error in check_checkout_rate_limit RPC:",
          rlError.message || "unknown_db_error",
        );
        return json({ error: "security_verification_failed" }, 500);
      }

      if (rlData === "user_banned") {
        return json({ error: "user_banned" }, 403);
      }

      if (rlData === "rate_limited") {
        return json({ error: "rate_limit_exceeded" }, 429);
      }

      if (rlData !== "ok") {
        console.error(
          "Unexpected return value from check_checkout_rate_limit RPC:",
          String(rlData),
        );
        return json({ error: "security_verification_failed" }, 500);
      }

      const redirectUrl = originValidation.origin ? `${originValidation.origin}/#success` : "";

      const checkoutAttributes: Record<string, unknown> = {
        custom_price: parsedPrice.minorUnits,
        checkout_data: {
          email: user.email || undefined,
          custom: {
            user_id: user.id,
            page_id: targetPageId,
            plan: String(plan),
            mode: effectiveMode,
          },
        },
        product_options: {
          redirect_url: redirectUrl || undefined,
        },
        test_mode: effectiveMode === "test",
      };

      const lemonPayload = {
        data: {
          type: "checkouts",
          attributes: checkoutAttributes,
          relationships: {
            store: {
              data: {
                type: "stores",
                id: secrets.storeId,
              },
            },
            variant: {
              data: {
                type: "variants",
                id: variantId,
              },
            },
          },
        },
      };

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CHECKOUT_TIMEOUT_MS);

      let lemonRes: Response;
      let lemonBodyText = "";
      try {
        lemonRes = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
          method: "POST",
          headers: {
            Accept: "application/vnd.api+json",
            "Content-Type": "application/vnd.api+json",
            Authorization: `Bearer ${secrets.apiKey}`,
          },
          body: JSON.stringify(lemonPayload),
          signal: controller.signal,
        });

        const boundedResponse = await readBoundedText(lemonRes.body, MAX_LEMON_RESPONSE_BYTES);
        if (!boundedResponse.ok) {
          return json({ error: "checkout_response_too_large" }, 502);
        }
        lemonBodyText = boundedResponse.text;
      } catch (fetchErr) {
        const isAbort = Boolean(
          fetchErr &&
            typeof fetchErr === "object" &&
            (fetchErr as { name?: unknown }).name === "AbortError",
        );
        return json({ error: isAbort ? "checkout_timeout" : "checkout_network_error" }, 504);
      } finally {
        clearTimeout(timeoutId);
      }

      if (!lemonRes.ok) {
        console.error("Lemon Squeezy checkout failed with status:", lemonRes.status);
        return json({ error: "checkout_failed", status: lemonRes.status }, 502);
      }

      let lemonData: Record<string, unknown>;
      try {
        lemonData = JSON.parse(lemonBodyText);
      } catch {
        return json({ error: "checkout_invalid_json" }, 502);
      }

      const checkoutUrl = (
        lemonData?.data as { attributes?: { url?: unknown } } | undefined
      )?.attributes?.url;

      if (!isValidLemonCheckoutUrl(checkoutUrl)) {
        return json({ error: "checkout_failed" }, 502);
      }

      return json({
        url: checkoutUrl.trim(),
        mode: effectiveMode,
      });
    } finally {
      ACTIVE_USER_CHECKOUTS.delete(user.id);
    }
  } catch (err) {
    console.error("Unhandled error in lemon-checkout:", err instanceof Error ? err.message : "unknown");
    return json({ error: "internal_error" }, 500);
  }
});

export {
  detectCurrencyFromPriceString,
  parsePriceToMinorUnits,
  validateTrustedOrigin,
  isValidLemonCheckoutUrl,
  resolveModeSecrets,
};
