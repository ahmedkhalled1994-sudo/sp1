import { createClient } from "npm:@supabase/supabase-js@2";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VARIANT_ID_REGEX = /^\d{1,20}$/;
const STORE_ID_REGEX = /^\d{1,20}$/;
const RESOURCE_ID_REGEX = /^\d{1,24}$/;
const ISO_CURRENCY_REGEX = /^[A-Z]{3}$/;
const HEX_SHA256_SIGNATURE_REGEX = /^[0-9a-f]{64}$/i;
const MAX_WEBHOOK_BODY_BYTES = 256 * 1024; // 256 KB
const MAX_SIGNATURE_HEADER_LENGTH = 128;

const ALLOWED_CUSTOM_DATA_KEYS = new Set([
  "user_id",
  "page_id",
  "plan",
  "mode",
]);

/**
 * Officially documented Lemon Squeezy currencies and their minor-unit exponents
 * verified from official Lemon Squeezy API documentation:
 * 1. The Order Object (`https://docs.lemonsqueezy.com/api/orders/the-order-object`):
 *    - `subtotal: 999`, `setup_fee: 999`, `discount_total: 0`, `tax: 200`, `total: 1199`,
 *      `currency: "USD"`, `total_formatted: "$11.99"` -> 2-decimal currency in integer cents (`10^2`).
 *    - Documented Order equation:
 *      - When `tax_inclusive === false`: `total = subtotal - discount_total + tax`
 *      - When `tax_inclusive === true`:  `total = subtotal - discount_total`
 *      - Note: `setup_fee` is already included within `subtotal` in Lemon Squeezy's Order object
 *        (`subtotal: 999` includes `setup_fee: 999`), so `setup_fee` MUST NEVER be added to `subtotal` again,
 *        and `0 <= setup_fee <= subtotal`.
 * 2. The Subscription Invoice Object (`https://docs.lemonsqueezy.com/api/subscription-invoices/the-subscription-invoice-object`):
 *    - `subtotal: 999`, `discount_total: 0`, `tax: 0`, `total: 999`, `currency: "USD"`, `total_formatted: "$9.99"`.
 *    - `subtotal: 1300`, `discount_total: 0`, `tax: 260`, `total: 1560`, `currency: "GBP"`, `total_formatted: "£15.60"`.
 * 3. Create a Checkout (`https://docs.lemonsqueezy.com/api/checkouts/create-a-checkout`):
 *    - "A positive integer in cents representing the custom price of the variant.
 *       Note: for zero-decimal currencies, the value should still be in the currency's smallest unit
 *       (e.g. 599 represents $5.99 for USD or ¥599 for JPY)."
 *
 * IMPORTANT SAFETY RULE:
 * - Numeric fields in Lemon Squeezy webhooks (`total`, `subtotal`, `discount_total`, `tax`, `setup_fee`, `refunded_amount`)
 *   are ALREADY in minor units (e.g. cents for USD/EUR/GBP, yen for JPY).
 * - They MUST NEVER be multiplied by 100 or 1000.
 * - If any monetary field contains a non-zero fractional part in minor units (e.g. `1859.76` EUR where
 *   `total_formatted` is `"€18.59"`), the webhook MUST preserve the exact raw string (`"1859.76"`),
 *   MUST NOT truncate `1859.76` into `1859` as an approved payment in `payments`, MUST NOT multiply by 100
 *   into `185976`, MUST NOT extend the subscription, and MUST log `fractional_minor_unit_requires_review`
 *   in `payment_reconciliation_issues`.
 */
const OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES: Record<string, number> = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CAD: 2,
  AUD: 2,
  JPY: 0,
};

const MONETARY_ATTRIBUTE_KEYS = new Set([
  "subtotal",
  "setup_fee",
  "discount_total",
  "tax",
  "total",
  "refunded_amount",
  "subtotal_usd",
  "setup_fee_usd",
  "discount_total_usd",
  "tax_usd",
  "total_usd",
  "refunded_amount_usd",
]);

function json(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function timingSafeHexEqual(aHex: string, bHex: string): boolean {
  const a = aHex.trim().toLowerCase();
  const b = bHex.trim().toLowerCase();
  if (!HEX_SHA256_SIGNATURE_REGEX.test(a) || !HEX_SHA256_SIGNATURE_REGEX.test(b)) {
    return false;
  }
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.length !== bBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < aBytes.length; i++) {
    diff |= aBytes[i] ^ bBytes[i];
  }
  return diff === 0;
}

async function computeHmacSha256Hex(secret: string, rawBytes: Uint8Array): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, rawBytes);
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function computeSha256Hex(rawBytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", rawBytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function readBoundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ ok: boolean; bytes: Uint8Array; tooLarge?: boolean }> {
  if (!stream) {
    return { ok: true, bytes: new Uint8Array(0) };
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
            // Ignore cancel error
          }
          return { ok: false, bytes: new Uint8Array(0), tooLarge: true };
        }
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore release error
    }
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: combined };
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

/**
 * Resolves mode-specific webhook signing secret and Store ID with ZERO generic fallbacks.
 * Generic variables (LEMONSQUEEZY_WEBHOOK_SECRET, LEMONSQUEEZY_STORE_ID) are strictly forbidden.
 */
function resolveWebhookModeSecrets(mode: "disabled" | "test" | "live"): {
  webhookSecret: string;
  expectedStoreId: string;
  hasSecretCollision: boolean;
} {
  const testSecret = String(Deno.env.get("LEMONSQUEEZY_TEST_WEBHOOK_SECRET") || "").trim();
  const liveSecret = String(Deno.env.get("LEMONSQUEEZY_LIVE_WEBHOOK_SECRET") || "").trim();

  const testStore = String(Deno.env.get("LEMONSQUEEZY_TEST_STORE_ID") || "").trim();
  const liveStore = String(Deno.env.get("LEMONSQUEEZY_LIVE_STORE_ID") || "").trim();

  const hasSecretCollision =
    (testSecret !== "" && liveSecret !== "" && testSecret === liveSecret) ||
    (testStore !== "" && liveStore !== "" && testStore === liveStore);

  if (mode === "test") {
    return {
      webhookSecret: testSecret,
      expectedStoreId: testStore,
      hasSecretCollision,
    };
  }

  if (mode === "live") {
    return {
      webhookSecret: liveSecret,
      expectedStoreId: liveStore,
      hasSecretCollision,
    };
  }

  return {
    webhookSecret: "",
    expectedStoreId: "",
    hasSecretCollision,
  };
}

/**
 * Determines event mode strictly from `data.attributes.test_mode` (boolean).
 * NEVER uses `meta.test_mode` as a fallback when `data.attributes.test_mode` is missing.
 * If `meta.test_mode` is present and conflicts with `data.attributes.test_mode`, rejects safely.
 */
function resolvePayloadTestMode(
  meta: Record<string, unknown>,
  attrs: Record<string, unknown>,
): {
  valid: boolean;
  isTestEvent: boolean;
  reason: string;
} {
  const hasAttr = typeof attrs.test_mode !== "undefined" && attrs.test_mode !== null;
  const hasMeta = typeof meta.test_mode !== "undefined" && meta.test_mode !== null;

  if (!hasAttr) {
    return { valid: false, isTestEvent: false, reason: "missing_boolean_test_mode" };
  }

  if (typeof attrs.test_mode !== "boolean") {
    return { valid: false, isTestEvent: false, reason: "non_boolean_attributes_test_mode" };
  }

  if (hasMeta && typeof meta.test_mode !== "boolean") {
    return { valid: false, isTestEvent: false, reason: "non_boolean_meta_test_mode" };
  }

  if (hasMeta && meta.test_mode !== attrs.test_mode) {
    return { valid: false, isTestEvent: false, reason: "conflicting_test_mode_flags" };
  }

  return {
    valid: true,
    isTestEvent: attrs.test_mode,
    reason: "ok",
  };
}

function validateAndSanitizeCustomData(
  rawCustomData: unknown,
  activeMode: "test" | "live",
): {
  ok: boolean;
  userId: string;
  pageId: string;
  plan: string;
  mode: string;
  sanitized: Record<string, string>;
  error?: string;
} {
  if (rawCustomData === undefined || rawCustomData === null) {
    return {
      ok: true,
      userId: "",
      pageId: "",
      plan: "",
      mode: "",
      sanitized: {},
    };
  }

  if (typeof rawCustomData !== "object" || Array.isArray(rawCustomData)) {
    return {
      ok: false,
      userId: "",
      pageId: "",
      plan: "",
      mode: "",
      sanitized: {},
      error: "invalid_custom_data_object",
    };
  }

  const obj = rawCustomData as Record<string, unknown>;
  const userId = String(obj.user_id || "").trim();
  const pageId = String(obj.page_id || "").trim();
  const plan = String(obj.plan || "").trim();
  const mode = String(obj.mode || "").trim().toLowerCase();

  if (userId !== "" && !UUID_REGEX.test(userId)) {
    return {
      ok: false,
      userId: "",
      pageId: "",
      plan: "",
      mode: "",
      sanitized: {},
      error: "invalid_custom_data_user_id",
    };
  }

  if (pageId !== "" && !UUID_REGEX.test(pageId)) {
    return {
      ok: false,
      userId,
      pageId: "",
      plan: "",
      mode: "",
      sanitized: {},
      error: "invalid_custom_data_page_id",
    };
  }

  if (plan !== "" && !["1", "2", "3"].includes(plan)) {
    return {
      ok: false,
      userId,
      pageId,
      plan: "",
      mode: "",
      sanitized: {},
      error: "invalid_custom_data_plan",
    };
  }

  if (mode !== "" && mode !== activeMode) {
    return {
      ok: false,
      userId,
      pageId,
      plan,
      mode,
      sanitized: {},
      error: "custom_data_mode_mismatch",
    };
  }

  const sanitized: Record<string, string> = {};
  for (const key of Object.keys(obj)) {
    if (ALLOWED_CUSTOM_DATA_KEYS.has(key) && obj[key] !== undefined && obj[key] !== null) {
      sanitized[key] = String(obj[key]).trim().slice(0, 128);
    }
  }

  return {
    ok: true,
    userId,
    pageId,
    plan,
    mode,
    sanitized,
  };
}

export interface RawMonetaryExtractionResult {
  ok: boolean;
  tokens: Record<string, string>;
  dataType: string;
  dataId: string;
  metaEventName: string;
  duplicateKeys: string[];
  error?: string;
}

/**
 * Lexer-based scanner that extracts exact raw JSON tokens for monetary fields
 * ONLY at `root -> "data" -> "attributes" -> <field>` (depth 3), while:
 * 1. Rejecting any duplicate keys in `root`, `meta`, `meta.custom_data`, `data`, or `data.attributes`.
 * 2. Ignoring decoy fields in `meta.custom_data` or nested objects inside `data.attributes`
 *    (such as `first_order_item.total` or `first_subscription_item`).
 * 3. Enforcing mandatory non-empty `data.type` and `data.id` and verifying them against
 *    `expectedResourceType` and `expectedResourceId`.
 */
function extractRawMonetaryTokens(
  rawJson: string,
  expectedResourceType?: string,
  expectedResourceId?: string,
): RawMonetaryExtractionResult {
  const tokens: Record<string, string> = {};
  const duplicateKeys: string[] = [];
  let dataType = "";
  let dataId = "";
  let metaEventName = "";

  const len = rawJson.length;
  let i = 0;

  type ScopeFrame = {
    type: "object" | "array";
    seenKeys: Set<string>;
    expectingKey: boolean;
    currentKey: string | null;
  };

  const stack: ScopeFrame[] = [];
  let inDataObject = false;
  let inAttributesObject = false;
  let inMetaObject = false;
  let inCustomDataObject = false;

  function skipWhitespace() {
    while (i < len) {
      const ch = rawJson.charCodeAt(i);
      if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
        i++;
      } else {
        break;
      }
    }
  }

  function readJsonString(): { raw: string; value: string } | null {
    if (rawJson[i] !== '"') return null;
    const start = i;
    i++; // skip opening quote
    let out = "";
    while (i < len) {
      const ch = rawJson[i];
      if (ch === "\\") {
        if (i + 1 >= len) return null;
        const next = rawJson[i + 1];
        if (next === '"' || next === "\\" || next === "/") {
          out += next;
          i += 2;
        } else if (next === "b") {
          out += "\b";
          i += 2;
        } else if (next === "f") {
          out += "\f";
          i += 2;
        } else if (next === "n") {
          out += "\n";
          i += 2;
        } else if (next === "r") {
          out += "\r";
          i += 2;
        } else if (next === "t") {
          out += "\t";
          i += 2;
        } else if (next === "u") {
          const hex = rawJson.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null;
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
        } else {
          return null;
        }
      } else if (ch === '"') {
        i++; // skip closing quote
        return { raw: rawJson.slice(start, i), value: out };
      } else {
        out += ch;
        i++;
      }
    }
    return null;
  }

  function readPrimitiveToken(): string | null {
    const start = i;
    while (i < len) {
      const ch = rawJson[i];
      if (
        ch === "," ||
        ch === "}" ||
        ch === "]" ||
        ch === " " ||
        ch === "\t" ||
        ch === "\n" ||
        ch === "\r"
      ) {
        break;
      }
      i++;
    }
    if (i === start) return null;
    return rawJson.slice(start, i);
  }

  skipWhitespace();
  if (i >= len || rawJson[i] !== "{") {
    return {
      ok: false,
      tokens,
      dataType,
      dataId,
      metaEventName,
      duplicateKeys,
      error: "root_must_be_json_object",
    };
  }

  while (i < len) {
    skipWhitespace();
    if (i >= len) break;

    const ch = rawJson[i];

    if (ch === "{") {
      const parent = stack.length > 0 ? stack[stack.length - 1] : null;
      const enteringData = stack.length === 1 && parent?.type === "object" && parent.currentKey === "data";
      const enteringMeta = stack.length === 1 && parent?.type === "object" && parent.currentKey === "meta";
      const enteringAttributes =
        stack.length === 2 &&
        inDataObject &&
        parent?.type === "object" &&
        parent.currentKey === "attributes";
      const enteringCustomData =
        stack.length === 2 &&
        inMetaObject &&
        parent?.type === "object" &&
        parent.currentKey === "custom_data";

      if (enteringData) inDataObject = true;
      if (enteringMeta) inMetaObject = true;
      if (enteringAttributes) inAttributesObject = true;
      if (enteringCustomData) inCustomDataObject = true;

      stack.push({
        type: "object",
        seenKeys: new Set<string>(),
        expectingKey: true,
        currentKey: null,
      });
      i++;
      continue;
    }

    if (ch === "[") {
      stack.push({
        type: "array",
        seenKeys: new Set<string>(),
        expectingKey: false,
        currentKey: null,
      });
      i++;
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (stack.length === 0) {
        return {
          ok: false,
          tokens,
          dataType,
          dataId,
          metaEventName,
          duplicateKeys,
          error: "unbalanced_closing_bracket",
        };
      }
      if (stack.length === 3 && inAttributesObject) {
        inAttributesObject = false;
      }
      if (stack.length === 3 && inCustomDataObject) {
        inCustomDataObject = false;
      }
      if (stack.length === 2 && inDataObject) {
        inDataObject = false;
      }
      if (stack.length === 2 && inMetaObject) {
        inMetaObject = false;
      }
      stack.pop();
      i++;

      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top && top.type === "object") {
        top.currentKey = null;
      }
      continue;
    }

    if (ch === ",") {
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top && top.type === "object") {
        top.expectingKey = true;
        top.currentKey = null;
      }
      i++;
      continue;
    }

    if (ch === ":") {
      const top = stack.length > 0 ? stack[stack.length - 1] : null;
      if (top && top.type === "object") {
        top.expectingKey = false;
      }
      i++;
      continue;
    }

    const top = stack.length > 0 ? stack[stack.length - 1] : null;
    if (!top) break;

    if (top.type === "object" && top.expectingKey) {
      const keyToken = readJsonString();
      if (!keyToken) {
        return {
          ok: false,
          tokens,
          dataType,
          dataId,
          metaEventName,
          duplicateKeys,
          error: "invalid_object_key",
        };
      }
      const key = keyToken.value;
      const depth = stack.length;

      // Check for duplicate keys in root (depth 1), data/meta (depth 2), and data.attributes / meta.custom_data (depth 3)
      const isSecuritySensitiveScope =
        depth === 1 ||
        (depth === 2 && (inDataObject || inMetaObject)) ||
        (depth === 3 && (inAttributesObject || inCustomDataObject));

      if (isSecuritySensitiveScope && top.seenKeys.has(key)) {
        duplicateKeys.push(key);
      }
      top.seenKeys.add(key);
      top.currentKey = key;
      continue;
    }

    // Reading a value (either object property value or array element)
    const depth = stack.length;
    const activeKey = top.type === "object" ? top.currentKey : null;

    if (ch === '"') {
      const strToken = readJsonString();
      if (!strToken) {
        return {
          ok: false,
          tokens,
          dataType,
          dataId,
          metaEventName,
          duplicateKeys,
          error: "unterminated_string_value",
        };
      }
      if (depth === 2 && inMetaObject && activeKey === "event_name") {
        metaEventName = strToken.value.trim();
      } else if (depth === 2 && inDataObject && activeKey === "type") {
        dataType = strToken.value.trim();
      } else if (depth === 2 && inDataObject && activeKey === "id") {
        dataId = strToken.value.trim();
      } else if (
        depth === 3 &&
        inAttributesObject &&
        activeKey &&
        MONETARY_ATTRIBUTE_KEYS.has(activeKey)
      ) {
        tokens[activeKey] = strToken.value.trim();
      }
      if (top.type === "object") {
        top.currentKey = null;
      }
      continue;
    }

    const prim = readPrimitiveToken();
    if (!prim) {
      return {
        ok: false,
        tokens,
        dataType,
        dataId,
        metaEventName,
        duplicateKeys,
        error: "invalid_primitive_token",
      };
    }

    if (depth === 2 && inDataObject && activeKey === "id" && prim !== "null") {
      dataId = prim.trim();
    } else if (
      depth === 3 &&
      inAttributesObject &&
      activeKey &&
      MONETARY_ATTRIBUTE_KEYS.has(activeKey)
    ) {
      if (prim !== "null") {
        tokens[activeKey] = prim.trim();
      }
    }

    if (top.type === "object") {
      top.currentKey = null;
    }
  }

  if (duplicateKeys.length > 0) {
    return {
      ok: false,
      tokens,
      dataType,
      dataId,
      metaEventName,
      duplicateKeys,
      error: "duplicate_json_key_detected",
    };
  }

  // Enforce mandatory non-empty `data.type` and `data.id` on every webhook resource
  if (!dataType) {
    return {
      ok: false,
      tokens,
      dataType,
      dataId,
      metaEventName,
      duplicateKeys,
      error: "missing_resource_type",
    };
  }

  if (!dataId || !RESOURCE_ID_REGEX.test(dataId)) {
    return {
      ok: false,
      tokens,
      dataType,
      dataId,
      metaEventName,
      duplicateKeys,
      error: "missing_resource_id",
    };
  }

  if (expectedResourceType !== undefined && (expectedResourceType === "" || dataType !== expectedResourceType)) {
    return {
      ok: false,
      tokens,
      dataType,
      dataId,
      metaEventName,
      duplicateKeys,
      error: "resource_type_mismatch",
    };
  }

  if (expectedResourceId !== undefined && (expectedResourceId === "" || dataId !== expectedResourceId)) {
    return {
      ok: false,
      tokens,
      dataType,
      dataId,
      metaEventName,
      duplicateKeys,
      error: "resource_id_mismatch",
    };
  }

  return {
    ok: true,
    tokens,
    dataType,
    dataId,
    metaEventName,
    duplicateKeys,
  };
}

export interface MonetaryTokenConversion {
  valid: boolean;
  minorUnits: number;
  rawToken: string;
  hasFractionalMinorUnits: boolean;
  fractionalPart: string;
  isNegative: boolean;
}

/**
 * Inspects a raw monetary token from Lemon Squeezy.
 * Since Lemon Squeezy ALREADY sends `subtotal`, `tax`, `discount_total`, `setup_fee`,
 * `total`, and `refunded_amount` in minor units (e.g. cents for USD/EUR/GBP, yen for JPY):
 * - Integer minor units (`"1199"`) -> `minorUnits = 1199`, `hasFractionalMinorUnits = false`.
 * - Decimal with all-zero fractional part (`"1199.00"`) -> `minorUnits = 1199`, `hasFractionalMinorUnits = false`.
 * - Decimal with non-zero fractional part (`"1859.76"`) -> `minorUnits = 1859`,
 *   `hasFractionalMinorUnits = true`, `fractionalPart = "76"`, `rawToken = "1859.76"`.
 *   NEVER multiplies by 100 (`1859.76` is NEVER `185976`), and NEVER approves `1859` as a valid payment!
 */
function convertTokenToMinorUnits(rawToken: string | undefined): MonetaryTokenConversion {
  const cleaned = String(rawToken ?? "").trim();
  if (!cleaned) {
    return {
      valid: false,
      minorUnits: 0,
      rawToken: "",
      hasFractionalMinorUnits: false,
      fractionalPart: "",
      isNegative: false,
    };
  }

  if (cleaned.startsWith("-")) {
    return {
      valid: false,
      minorUnits: -1,
      rawToken: cleaned,
      hasFractionalMinorUnits: false,
      fractionalPart: "",
      isNegative: true,
    };
  }

  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) {
    return {
      valid: false,
      minorUnits: 0,
      rawToken: cleaned,
      hasFractionalMinorUnits: false,
      fractionalPart: "",
      isNegative: false,
    };
  }

  const [wholeStr, fracStr = ""] = cleaned.split(".");
  const strippedFraction = fracStr.replace(/0+$/, "");

  const minorUnits = Number(wholeStr);
  if (!Number.isSafeInteger(minorUnits) || minorUnits < 0) {
    return {
      valid: false,
      minorUnits: 0,
      rawToken: cleaned,
      hasFractionalMinorUnits: false,
      fractionalPart: "",
      isNegative: false,
    };
  }

  if (strippedFraction.length > 0) {
    return {
      valid: true,
      minorUnits,
      rawToken: cleaned,
      hasFractionalMinorUnits: true,
      fractionalPart: strippedFraction,
      isNegative: false,
    };
  }

  return {
    valid: true,
    minorUnits,
    rawToken: cleaned,
    hasFractionalMinorUnits: false,
    fractionalPart: "",
    isNegative: false,
  };
}

/**
 * Extracts digits from `total_formatted` (e.g. "$11.99" -> 1199, "€18.59" -> 1859, "¥599" -> 599)
 * strictly as a secondary consistency check against `total`.
 */
function parseFormattedDisplayMinorUnits(
  formatted: unknown,
  currency: string,
): { present: boolean; minorUnits: number | null } {
  if (typeof formatted !== "string" || !formatted.trim()) {
    return { present: false, minorUnits: null };
  }
  const exponent = OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES[currency];
  if (exponent === undefined) {
    return { present: true, minorUnits: null };
  }

  const match = formatted.match(/(\d[\d,.]*)/);
  if (!match) {
    return { present: true, minorUnits: null };
  }

  const rawNum = match[1];
  if (exponent === 0) {
    const digitsOnly = rawNum.replace(/[,.]/g, "");
    const val = Number(digitsOnly);
    return { present: true, minorUnits: Number.isSafeInteger(val) ? val : null };
  }

  const decMatch = rawNum.match(/^(.*)[.,](\d{2})$/);
  if (decMatch) {
    const majorDigits = decMatch[1].replace(/[,.]/g, "");
    const minorDigits = decMatch[2];
    const val = Number(`${majorDigits}${minorDigits}`);
    return { present: true, minorUnits: Number.isSafeInteger(val) ? val : null };
  }

  const digitsOnly = rawNum.replace(/[,.]/g, "");
  const val = Number(digitsOnly) * 10 ** exponent;
  return { present: true, minorUnits: Number.isSafeInteger(val) ? val : null };
}

export interface WebhookMonetaryNormalizationResult {
  valid: boolean;
  requiresReconciliation: boolean;
  reconciliationReason: string;
  currency: string;
  currencyExponent: number | null;
  isDocumentedCurrency: boolean;
  /**
   * Approved integer minor units ONLY when `valid === true && !requiresReconciliation`.
   * Always `null` when `requiresReconciliation === true` so no caller can ever
   * mistake a truncated/unverified number for an approved payment amount.
   */
  approvedTotalMinor: number | null;
  /**
   * Unapproved integer part kept ONLY for human reconciliation diagnostics.
   */
  unapprovedTruncatedMinor: number;
  subtotalMinor: number;
  setupFeeMinor: number;
  discountMinor: number;
  taxMinor: number;
  refundedMinor: number;
  hasExplicitRefundedAmount: boolean;
  rawTotalString: string;
  rawRefundedString: string;
  hasFractionalMinorUnits: boolean;
  fractionalMinorPart: string;
  errorCode: string;
}

/**
 * Normalizes and validates all monetary fields on a Lemon Squeezy Order or Subscription Invoice.
 *
 * Enforces:
 * 1. Currency must be a valid 3-letter ISO 4217 code (NEVER defaults to USD if missing).
 * 2. Currency must be in `OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES`; otherwise
 *    `requiresReconciliation = true` (`unverified_currency_unit_requires_review`) and `approvedTotalMinor = null`.
 * 3. `total` must be present, non-negative, and > 0 for paid extensions.
 * 4. If `total` or any breakdown field has fractional minor units (e.g. `1859.76` EUR),
 *    `requiresReconciliation = true` (`fractional_minor_unit_requires_review`) and `approvedTotalMinor = null`.
 * 5. Breakdown equation verification (`subtotal`, `discount_total`, `tax` must be present on paid events):
 *    - `setup_fee` is included inside `subtotal` in Lemon Squeezy's Order object (`subtotal = 999, setup_fee = 999, tax = 200 => total = 1199`).
 *    - Never adds `setup_fee` on top of `subtotal`.
 *    - Checks `0 <= setup_fee <= subtotal`.
 *    - Checks `subtotal - discount_total + tax === total` (or `subtotal - discount_total === total` when `tax_inclusive === true`).
 * 6. Cross-checks `total_formatted` when present (`formatted_total_mismatch_requires_review` on mismatch).
 */
function normalizeWebhookMonetaryFields(
  rawBodyString: string,
  attrs: Record<string, unknown>,
  requirePositiveTotal: boolean,
  expectedResourceType?: string,
  expectedResourceId?: string,
): WebhookMonetaryNormalizationResult {
  const rawCurrency = typeof attrs.currency === "string" ? attrs.currency.trim().toUpperCase() : "";
  if (!ISO_CURRENCY_REGEX.test(rawCurrency)) {
    return {
      valid: false,
      requiresReconciliation: false,
      reconciliationReason: "",
      currency: rawCurrency,
      currencyExponent: null,
      isDocumentedCurrency: false,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: 0,
      subtotalMinor: 0,
      setupFeeMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      refundedMinor: 0,
      hasExplicitRefundedAmount: false,
      rawTotalString: "",
      rawRefundedString: "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: "invalid_currency_code",
    };
  }

  const isDocumentedCurrency = Object.prototype.hasOwnProperty.call(
    OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES,
    rawCurrency,
  );
  const currencyExponent = isDocumentedCurrency
    ? OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES[rawCurrency]
    : null;

  const extraction = extractRawMonetaryTokens(
    rawBodyString,
    expectedResourceType,
    expectedResourceId,
  );
  if (!extraction.ok) {
    return {
      valid: false,
      requiresReconciliation: false,
      reconciliationReason: "",
      currency: rawCurrency,
      currencyExponent,
      isDocumentedCurrency,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: 0,
      subtotalMinor: 0,
      setupFeeMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      refundedMinor: 0,
      hasExplicitRefundedAmount: false,
      rawTotalString: "",
      rawRefundedString: "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: extraction.error || "invalid_monetary_json_structure",
    };
  }

  const rawTokens = extraction.tokens;
  const rawTotalToken = rawTokens.total;

  if (rawTotalToken === undefined || rawTotalToken === "") {
    return {
      valid: false,
      requiresReconciliation: false,
      reconciliationReason: "",
      currency: rawCurrency,
      currencyExponent,
      isDocumentedCurrency,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: 0,
      subtotalMinor: 0,
      setupFeeMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      refundedMinor: 0,
      hasExplicitRefundedAmount: false,
      rawTotalString: "",
      rawRefundedString: "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: "invalid_payment_amount",
    };
  }

  const totalConv = convertTokenToMinorUnits(rawTotalToken);
  if (!totalConv.valid || totalConv.isNegative) {
    return {
      valid: false,
      requiresReconciliation: false,
      reconciliationReason: "",
      currency: rawCurrency,
      currencyExponent,
      isDocumentedCurrency,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: 0,
      subtotalMinor: 0,
      setupFeeMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      refundedMinor: 0,
      hasExplicitRefundedAmount: false,
      rawTotalString: totalConv.rawToken,
      rawRefundedString: "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: "invalid_payment_amount",
    };
  }

  if (requirePositiveTotal && totalConv.minorUnits === 0 && !totalConv.hasFractionalMinorUnits) {
    return {
      valid: false,
      requiresReconciliation: false,
      reconciliationReason: "",
      currency: rawCurrency,
      currencyExponent,
      isDocumentedCurrency,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: 0,
      subtotalMinor: 0,
      setupFeeMinor: 0,
      discountMinor: 0,
      taxMinor: 0,
      refundedMinor: 0,
      hasExplicitRefundedAmount: false,
      rawTotalString: totalConv.rawToken,
      rawRefundedString: "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: "invalid_payment_amount",
    };
  }

  const hasSubtotal = rawTokens.subtotal !== undefined;
  const hasSetupFee = rawTokens.setup_fee !== undefined;
  const hasDiscount = rawTokens.discount_total !== undefined;
  const hasTax = rawTokens.tax !== undefined;
  const hasExplicitRefundedAmount = rawTokens.refunded_amount !== undefined;

  const subtotalConv = hasSubtotal ? convertTokenToMinorUnits(rawTokens.subtotal) : null;
  const setupFeeConv = hasSetupFee ? convertTokenToMinorUnits(rawTokens.setup_fee) : null;
  const discountConv = hasDiscount ? convertTokenToMinorUnits(rawTokens.discount_total) : null;
  const taxConv = hasTax ? convertTokenToMinorUnits(rawTokens.tax) : null;
  const refundConv = hasExplicitRefundedAmount
    ? convertTokenToMinorUnits(rawTokens.refunded_amount)
    : null;

  for (const sub of [subtotalConv, setupFeeConv, discountConv, taxConv, refundConv]) {
    if (sub && (!sub.valid || sub.isNegative)) {
      return {
        valid: false,
        requiresReconciliation: false,
        reconciliationReason: "",
        currency: rawCurrency,
        currencyExponent,
        isDocumentedCurrency,
        approvedTotalMinor: null,
        unapprovedTruncatedMinor: 0,
        subtotalMinor: 0,
        setupFeeMinor: 0,
        discountMinor: 0,
        taxMinor: 0,
        refundedMinor: 0,
        hasExplicitRefundedAmount,
        rawTotalString: totalConv.rawToken,
        rawRefundedString: refundConv?.rawToken || "",
        hasFractionalMinorUnits: false,
        fractionalMinorPart: "",
        errorCode: "invalid_payment_amount",
      };
    }
  }

  const anyFractionalMinor = Boolean(
    totalConv.hasFractionalMinorUnits ||
      subtotalConv?.hasFractionalMinorUnits ||
      setupFeeConv?.hasFractionalMinorUnits ||
      discountConv?.hasFractionalMinorUnits ||
      taxConv?.hasFractionalMinorUnits ||
      refundConv?.hasFractionalMinorUnits,
  );

  // 1. Check for fractional minor units (e.g. `1859.76` EUR where `"€18.59"` is 1859.76 cents)
  if (anyFractionalMinor) {
    return {
      valid: true,
      requiresReconciliation: true,
      reconciliationReason: "fractional_minor_unit_requires_review",
      currency: rawCurrency,
      currencyExponent,
      isDocumentedCurrency,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: totalConv.minorUnits,
      subtotalMinor: subtotalConv?.minorUnits ?? 0,
      setupFeeMinor: setupFeeConv?.minorUnits ?? 0,
      discountMinor: discountConv?.minorUnits ?? 0,
      taxMinor: taxConv?.minorUnits ?? 0,
      refundedMinor: refundConv?.minorUnits ?? 0,
      hasExplicitRefundedAmount,
      rawTotalString: totalConv.rawToken,
      rawRefundedString: refundConv?.rawToken || "",
      hasFractionalMinorUnits: true,
      fractionalMinorPart:
        totalConv.fractionalPart ||
        subtotalConv?.fractionalPart ||
        taxConv?.fractionalPart ||
        refundConv?.fractionalPart ||
        "fractional",
      errorCode: "ok",
    };
  }

  // 2. Check if currency is officially documented with verified minor-unit examples in Lemon Squeezy docs
  if (!isDocumentedCurrency) {
    return {
      valid: true,
      requiresReconciliation: true,
      reconciliationReason: "unverified_currency_unit_requires_review",
      currency: rawCurrency,
      currencyExponent: null,
      isDocumentedCurrency: false,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: totalConv.minorUnits,
      subtotalMinor: subtotalConv?.minorUnits ?? 0,
      setupFeeMinor: setupFeeConv?.minorUnits ?? 0,
      discountMinor: discountConv?.minorUnits ?? 0,
      taxMinor: taxConv?.minorUnits ?? 0,
      refundedMinor: refundConv?.minorUnits ?? 0,
      hasExplicitRefundedAmount,
      rawTotalString: totalConv.rawToken,
      rawRefundedString: refundConv?.rawToken || "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: "ok",
    };
  }

  // 3. Require and verify the documented Lemon Squeezy breakdown equation on paid events:
  //    In Lemon Squeezy's official Order object (`subtotal = 999, setup_fee = 999, discount_total = 0, tax = 200, total = 1199`),
  //    `setup_fee` is ALREADY included in `subtotal` (`0 <= setup_fee <= subtotal`),
  //    and `total = subtotal - discount_total + tax` (or `subtotal - discount_total` when `tax_inclusive === true`).
  if (requirePositiveTotal) {
    if (!subtotalConv || !discountConv || !taxConv) {
      return {
        valid: true,
        requiresReconciliation: true,
        reconciliationReason: "missing_amount_breakdown_requires_review",
        currency: rawCurrency,
        currencyExponent,
        isDocumentedCurrency: true,
        approvedTotalMinor: null,
        unapprovedTruncatedMinor: totalConv.minorUnits,
        subtotalMinor: subtotalConv?.minorUnits ?? 0,
        setupFeeMinor: setupFeeConv?.minorUnits ?? 0,
        discountMinor: discountConv?.minorUnits ?? 0,
        taxMinor: taxConv?.minorUnits ?? 0,
        refundedMinor: refundConv?.minorUnits ?? 0,
        hasExplicitRefundedAmount,
        rawTotalString: totalConv.rawToken,
        rawRefundedString: refundConv?.rawToken || "",
        hasFractionalMinorUnits: false,
        fractionalMinorPart: "",
        errorCode: "ok",
      };
    }

    const setupFeeExceedsSubtotal =
      setupFeeConv !== null && setupFeeConv.minorUnits > subtotalConv.minorUnits;

    const taxInclusive = attrs.tax_inclusive === true;
    const expectedTotalTaxExclusive =
      subtotalConv.minorUnits - discountConv.minorUnits + taxConv.minorUnits;
    const expectedTotalTaxInclusive = subtotalConv.minorUnits - discountConv.minorUnits;

    const matchesBreakdown = taxInclusive
      ? expectedTotalTaxInclusive === totalConv.minorUnits
      : expectedTotalTaxExclusive === totalConv.minorUnits;

    if (setupFeeExceedsSubtotal || !matchesBreakdown) {
      return {
        valid: true,
        requiresReconciliation: true,
        reconciliationReason: "inconsistent_amount_breakdown_requires_review",
        currency: rawCurrency,
        currencyExponent,
        isDocumentedCurrency: true,
        approvedTotalMinor: null,
        unapprovedTruncatedMinor: totalConv.minorUnits,
        subtotalMinor: subtotalConv.minorUnits,
        setupFeeMinor: setupFeeConv?.minorUnits ?? 0,
        discountMinor: discountConv.minorUnits,
        taxMinor: taxConv.minorUnits,
        refundedMinor: refundConv?.minorUnits ?? 0,
        hasExplicitRefundedAmount,
        rawTotalString: totalConv.rawToken,
        rawRefundedString: refundConv?.rawToken || "",
        hasFractionalMinorUnits: false,
        fractionalMinorPart: "",
        errorCode: "ok",
      };
    }
  }

  // 4. Cross-check `total_formatted` when present (e.g. "$11.99" must match `1199`)
  const formattedCheck = parseFormattedDisplayMinorUnits(attrs.total_formatted, rawCurrency);
  if (
    formattedCheck.present &&
    formattedCheck.minorUnits !== null &&
    formattedCheck.minorUnits !== totalConv.minorUnits
  ) {
    return {
      valid: true,
      requiresReconciliation: true,
      reconciliationReason: "formatted_total_mismatch_requires_review",
      currency: rawCurrency,
      currencyExponent,
      isDocumentedCurrency: true,
      approvedTotalMinor: null,
      unapprovedTruncatedMinor: totalConv.minorUnits,
      subtotalMinor: subtotalConv?.minorUnits ?? totalConv.minorUnits,
      setupFeeMinor: setupFeeConv?.minorUnits ?? 0,
      discountMinor: discountConv?.minorUnits ?? 0,
      taxMinor: taxConv?.minorUnits ?? 0,
      refundedMinor: refundConv?.minorUnits ?? 0,
      hasExplicitRefundedAmount,
      rawTotalString: totalConv.rawToken,
      rawRefundedString: refundConv?.rawToken || "",
      hasFractionalMinorUnits: false,
      fractionalMinorPart: "",
      errorCode: "ok",
    };
  }

  return {
    valid: true,
    requiresReconciliation: false,
    reconciliationReason: "ok",
    currency: rawCurrency,
    currencyExponent,
    isDocumentedCurrency: true,
    approvedTotalMinor: totalConv.minorUnits,
    unapprovedTruncatedMinor: totalConv.minorUnits,
    subtotalMinor: subtotalConv?.minorUnits ?? totalConv.minorUnits,
    setupFeeMinor: setupFeeConv?.minorUnits ?? 0,
    discountMinor: discountConv?.minorUnits ?? 0,
    taxMinor: taxConv?.minorUnits ?? 0,
    refundedMinor: refundConv?.minorUnits ?? 0,
    hasExplicitRefundedAmount,
    rawTotalString: totalConv.rawToken,
    rawRefundedString: refundConv?.rawToken || "",
    hasFractionalMinorUnits: false,
    fractionalMinorPart: "",
    errorCode: "ok",
  };
}

const PRE_COMMIT_REJECTION_CODES = new Set([
  "invalid_delivery_or_event_key",
  "invalid_store_id",
  "missing_resource_type",
  "invalid_resource_id",
  "invalid_resource_type_for_event",
]);

const KNOWN_PERSISTED_RECONCILIATION_CODES = new Set([
  "missing_pricing_settings",
  "provider_disabled_in_db",
  "webhook_mode_mismatch",
  "store_id_mismatch",
  "invalid_payment_provider",
  "provider_disabled",
  "test_live_variant_collision",
  "duplicate_variant_id",
  "unknown_variant_for_test_mode",
  "unknown_variant_for_live_mode",
  "invalid_payment_mode",
  "invalid_plan",
  "invalid_plan_days",
  "page_ownership_mismatch",
  "missing_page",
  "ambiguous_page_selection",
  "user_banned",
  "duplicate_conflict",
  "fractional_minor_unit_requires_review",
  "unverified_currency_unit_requires_review",
  "inconsistent_amount_breakdown_requires_review",
  "missing_amount_breakdown_requires_review",
  "formatted_total_mismatch_requires_review",
  "invalid_event_key",
  "missing_user",
  "invalid_variant",
  "invalid_payment_amount",
  "invalid_currency",
]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: "server_misconfigured" }, 500);
    }

    const envState = resolveProviderModeFromEnv();
    if (envState.hasInvalidMode) {
      return json({ error: "invalid_provider_mode" }, 503);
    }

    if (!envState.enabled || envState.mode === "disabled") {
      return json(
        {
          error: "provider_disabled",
          mode: "disabled",
          message: "Webhook processing is disabled while payment provider is inactive.",
        },
        503,
      );
    }

    const secrets = resolveWebhookModeSecrets(envState.mode);
    if (secrets.hasSecretCollision) {
      return json({ error: "test_live_secret_collision" }, 503);
    }

    if (!secrets.webhookSecret) {
      return json({ error: "missing_webhook_secret" }, 503);
    }

    if (!STORE_ID_REGEX.test(secrets.expectedStoreId)) {
      return json({ error: "missing_store_id" }, 503);
    }

    // 1. Verify X-Signature header presence & bounds BEFORE reading body
    const signatureHeader = (
      req.headers.get("X-Signature") ||
      req.headers.get("x-signature") ||
      ""
    ).trim();

    if (!signatureHeader) {
      return json({ error: "missing_signature" }, 401);
    }

    if (signatureHeader.length > MAX_SIGNATURE_HEADER_LENGTH) {
      return json({ error: "invalid_signature" }, 401);
    }

    // 2. Enforce bounded request body size (MAX_WEBHOOK_BODY_BYTES = 256 KB)
    const contentLengthHeader = req.headers.get("Content-Length");
    if (contentLengthHeader) {
      const declaredBytes = Number(contentLengthHeader);
      if (!Number.isFinite(declaredBytes) || declaredBytes < 0 || declaredBytes > MAX_WEBHOOK_BODY_BYTES) {
        return json({ error: "payload_too_large" }, 413);
      }
    }

    const boundedBody = await readBoundedBytes(req.body, MAX_WEBHOOK_BODY_BYTES);
    if (!boundedBody.ok) {
      return json({ error: "payload_too_large" }, 413);
    }

    const rawBytes = boundedBody.bytes;
    if (rawBytes.byteLength === 0) {
      return json({ error: "empty_body" }, 400);
    }

    // 3. Verify HMAC-SHA256 signature on exact raw bytes in constant time BEFORE JSON.parse
    const computedSignature = await computeHmacSha256Hex(secrets.webhookSecret, rawBytes);
    if (!timingSafeHexEqual(computedSignature, signatureHeader)) {
      return json({ error: "invalid_signature" }, 401);
    }

    const rawBodyString = new TextDecoder("utf-8", { fatal: false }).decode(rawBytes);

    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBodyString);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return json({ error: "invalid_json" }, 400);
      }
      payload = parsed as Record<string, unknown>;
    } catch {
      return json({ error: "invalid_json" }, 400);
    }

    const meta = (payload.meta as Record<string, unknown>) || {};
    const data = (payload.data as Record<string, unknown>) || {};
    const attrs = (data.attributes as Record<string, unknown>) || {};

    const metaEventName = String(meta.event_name || "").trim();
    const headerEventName = String(
      req.headers.get("X-Event-Name") || req.headers.get("x-event-name") || "",
    ).trim();

    if (!metaEventName) {
      return json({ error: "missing_event_name" }, 400);
    }

    if (headerEventName && headerEventName !== metaEventName) {
      return json({ error: "event_name_header_mismatch" }, 400);
    }

    // 4. Verify test_mode strictly from `data.attributes.test_mode` (boolean)
    const testModeCheck = resolvePayloadTestMode(meta, attrs);
    if (!testModeCheck.valid) {
      return json({ error: "malformed_test_mode_flag", reason: testModeCheck.reason }, 400);
    }

    if (envState.mode === "live" && testModeCheck.isTestEvent) {
      return json({ error: "test_webhook_in_live_mode" }, 400);
    }
    if (envState.mode === "test" && !testModeCheck.isTestEvent) {
      return json({ error: "live_webhook_in_test_mode" }, 400);
    }

    // 5. Verify Store ID presence, numeric format, and exact match with mode-specific store ID
    const rawStoreId = String(attrs.store_id ?? "").trim();
    if (!STORE_ID_REGEX.test(rawStoreId)) {
      return json({ error: "missing_store_id" }, 400);
    }
    if (rawStoreId !== secrets.expectedStoreId) {
      return json({ error: "store_id_mismatch" }, 400);
    }

    // 6. Mandatory `data.type` and `data.id` verification before any processing
    const resourceType = typeof data.type === "string" ? data.type.trim() : "";
    const resourceId =
      typeof data.id === "string" || typeof data.id === "number" ? String(data.id).trim() : "";

    if (!resourceType) {
      return json({ error: "missing_resource_type" }, 400);
    }

    if (!resourceId || !RESOURCE_ID_REGEX.test(resourceId)) {
      return json({ error: "missing_resource_id" }, 400);
    }

    // Verify raw JSON structure (no duplicate keys in root, meta, meta.custom_data, data, or data.attributes)
    // and confirm raw `data.type`, `data.id`, and `meta.event_name` match parsed values
    const rawStructureCheck = extractRawMonetaryTokens(rawBodyString, resourceType, resourceId);
    if (!rawStructureCheck.ok) {
      return json({ error: rawStructureCheck.error || "invalid_monetary_json_structure" }, 400);
    }
    if (rawStructureCheck.metaEventName && rawStructureCheck.metaEventName !== metaEventName) {
      return json({ error: "event_name_mismatch" }, 400);
    }

    const deliveryHash = await computeSha256Hex(rawBytes);
    const deliveryId = `wh_${deliveryHash}`;
    const eventKey = `${metaEventName}:${resourceId}`;

    // Validate and sanitize `meta.custom_data`
    const customDataCheck = validateAndSanitizeCustomData(meta.custom_data, envState.mode);
    const userId = customDataCheck.userId;
    const pageId = customDataCheck.pageId;

    const firstOrderItem = (attrs.first_order_item as Record<string, unknown>) || {};
    const firstSubItem = (attrs.first_subscription_item as Record<string, unknown>) || {};
    const variantId = String(
      firstOrderItem.variant_id || firstSubItem.variant_id || attrs.variant_id || "",
    ).trim();

    const orderId = String(
      resourceType === "orders" ? resourceId : attrs.order_id || "",
    ).trim();
    const subscriptionId = String(
      resourceType === "subscriptions" ? resourceId : attrs.subscription_id || "",
    ).trim();
    const customerEmail = String(attrs.user_email || "")
      .trim()
      .slice(0, 320);
    const status = String(attrs.status || "")
      .trim()
      .toLowerCase();
    const billingReason = String(attrs.billing_reason || "")
      .trim()
      .toLowerCase();
    const isRefundedAttr = Boolean(attrs.refunded);

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // =========================================================================
    // CASE 1: Non-extending Subscription Lifecycle & Refund Events
    // =========================================================================
    const rawTokens = rawStructureCheck.tokens;
    const refundTokenConv =
      rawTokens.refunded_amount !== undefined
        ? convertTokenToMinorUnits(rawTokens.refunded_amount)
        : null;
    const hasPositiveRefundToken = Boolean(
      refundTokenConv &&
        refundTokenConv.valid &&
        !refundTokenConv.isNegative &&
        (refundTokenConv.minorUnits > 0 || refundTokenConv.hasFractionalMinorUnits),
    );

    const isRefundOrLifecycleEvent =
      metaEventName === "order_refunded" ||
      metaEventName === "subscription_payment_refunded" ||
      metaEventName === "subscription_payment_failed" ||
      metaEventName === "subscription_payment_recovered" ||
      metaEventName === "subscription_cancelled" ||
      metaEventName === "subscription_expired" ||
      metaEventName === "subscription_created" ||
      metaEventName === "subscription_updated" ||
      metaEventName === "subscription_resumed" ||
      metaEventName === "subscription_paused" ||
      metaEventName === "subscription_unpaused" ||
      isRefundedAttr ||
      status === "refunded" ||
      status === "partially_refunded" ||
      hasPositiveRefundToken;

    if (isRefundOrLifecycleEvent) {
      const rawCurrency = typeof attrs.currency === "string" ? attrs.currency.trim().toUpperCase() : "";
      const isDocCurrency = Object.prototype.hasOwnProperty.call(
        OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES,
        rawCurrency,
      );
      const totalConv =
        rawTokens.total !== undefined ? convertTokenToMinorUnits(rawTokens.total) : null;
      const refundConv = refundTokenConv;
      const hasExplicitRefundedAmount = rawTokens.refunded_amount !== undefined;

      const totalMinor =
        totalConv && totalConv.valid && !totalConv.isNegative && !totalConv.hasFractionalMinorUnits
          ? totalConv.minorUnits
          : 0;
      const rawRefundMinor =
        refundConv && refundConv.valid && !refundConv.isNegative && !refundConv.hasFractionalMinorUnits
          ? refundConv.minorUnits
          : 0;

      const isRefundRelated =
        metaEventName === "order_refunded" ||
        metaEventName === "subscription_payment_refunded" ||
        isRefundedAttr ||
        status === "refunded" ||
        status === "partially_refunded" ||
        hasPositiveRefundToken;

      // Classify refund into 6 distinct states without ever using 0 as a fallback for unknown/invalid amounts:
      // 1. "full": verified positive integer `refunded_amount === totalMinor > 0` in documented currency
      // 2. "partial": verified positive integer `0 < refunded_amount < totalMinor` in documented currency
      // 3. "zero_verified": explicit `refunded_amount === 0` in documented currency with `totalMinor > 0`
      // 4. "fractional_requires_review": fractional minor units present on `refunded_amount` or `total`
      // 5. "unknown_missing": `refunded_amount` attribute omitted from payload
      // 6. "invalid_unverified": negative/malformed `refunded_amount`, `refunded_amount > total`, or undocumented currency
      let refundType:
        | "none"
        | "full"
        | "partial"
        | "zero_verified"
        | "fractional_requires_review"
        | "unknown_missing"
        | "invalid_unverified" = "none";
      let verifiedRefundMinor: number | null = null;
      let reason = metaEventName;

      if (isRefundRelated) {
        const hasFractionalRefundOrTotal = Boolean(
          totalConv?.hasFractionalMinorUnits || refundConv?.hasFractionalMinorUnits,
        );

        if (hasFractionalRefundOrTotal) {
          refundType = "fractional_requires_review";
          verifiedRefundMinor = null;
          reason = "refund_amount_fractional_requires_admin_review";
        } else if (!hasExplicitRefundedAmount) {
          refundType = "unknown_missing";
          verifiedRefundMinor = null;
          reason = "refund_amount_unverified_requires_admin_review";
        } else if (
          !isDocCurrency ||
          refundConv === null ||
          !refundConv.valid ||
          refundConv.isNegative ||
          totalMinor <= 0 ||
          rawRefundMinor > totalMinor
        ) {
          refundType = "invalid_unverified";
          verifiedRefundMinor = null;
          reason = "refund_amount_unverified_requires_admin_review";
        } else if (rawRefundMinor === 0) {
          refundType = "zero_verified";
          verifiedRefundMinor = 0;
          reason = "refund_amount_zero_requires_admin_review";
        } else if (rawRefundMinor < totalMinor || status === "partially_refunded") {
          refundType = "partial";
          verifiedRefundMinor = rawRefundMinor;
          reason = "partial_refund_requires_admin_review";
        } else {
          refundType = "full";
          verifiedRefundMinor = rawRefundMinor;
          reason = "refund_requires_admin_review";
        }
      } else if (metaEventName === "subscription_payment_failed") {
        reason = "subscription_payment_failed";
      } else if (metaEventName === "subscription_payment_recovered") {
        reason = "subscription_payment_recovered_no_double_extend";
      }

      const rawRefundedTokenString = refundConv?.rawToken ?? "";

      const lifecycleMeta = {
        event_name: metaEventName,
        status,
        billing_reason: billingReason,
        refunded: isRefundedAttr,
        refund_type: refundType,
        refunded_amount: verifiedRefundMinor,
        has_explicit_refunded_amount: hasExplicitRefundedAmount,
        provider_total_raw: totalConv?.rawToken ?? null,
        provider_refunded_raw: rawRefundedTokenString || null,
        has_fractional_minor_units: Boolean(
          totalConv?.hasFractionalMinorUnits || refundConv?.hasFractionalMinorUnits,
        ),
        currency_documented: isDocCurrency,
        custom_data: customDataCheck.sanitized,
      };

      // Single atomic database transaction via RPC (no split PostgREST upsert)
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        "process_lemon_lifecycle_webhook",
        {
          p_delivery_id: deliveryId,
          p_event_key: eventKey,
          p_event_name: metaEventName,
          p_resource_type: resourceType,
          p_resource_id: resourceId,
          p_store_id: rawStoreId,
          p_test_mode: testModeCheck.isTestEvent,
          p_user_id: UUID_REGEX.test(userId) ? userId : null,
          p_page_id: UUID_REGEX.test(pageId) ? pageId : null,
          p_variant_id: variantId,
          p_order_id: orderId,
          p_subscription_id: subscriptionId,
          p_amount: isDocCurrency ? totalMinor : 0,
          p_refunded_amount: verifiedRefundMinor,
          p_raw_refunded_amount: rawRefundedTokenString,
          p_refund_type: refundType,
          p_currency: ISO_CURRENCY_REGEX.test(rawCurrency) ? rawCurrency : "USD",
          p_reason: reason,
          p_raw_meta: lifecycleMeta,
        },
      );

      if (rpcErr) {
        console.error("Database error in process_lemon_lifecycle_webhook:", rpcErr.message);
        return json({ error: "database_rpc_error" }, 500);
      }

      const lifecycleResultCode = String(rpcResult || "");
      if (PRE_COMMIT_REJECTION_CODES.has(lifecycleResultCode)) {
        return json({ error: lifecycleResultCode }, 400);
      }
      if (lifecycleResultCode !== "ok" && lifecycleResultCode !== "duplicate_delivery") {
        console.error("Unexpected result from process_lemon_lifecycle_webhook:", lifecycleResultCode);
        return json({ error: "database_rpc_error" }, 500);
      }

      return json({
        status: isRefundRelated ? "reconciliation_logged" : "acknowledged_no_extension",
        event: metaEventName,
        reason,
        refund_type: refundType,
        refunded_amount_minor: verifiedRefundMinor,
        result: lifecycleResultCode,
        subscription_extended: false,
      });
    }

    // =========================================================================
    // CASE 2: Prevent Double Extension on Initial Subscription Invoice
    // =========================================================================
    // In Lemon Squeezy, the initial purchase triggers BOTH `order_created` and
    // `subscription_payment_success` (with `billing_reason === "initial"`).
    // Only `order_created` extends on initial purchase; `subscription_payment_success`
    // extends ONLY on renewals (`billing_reason !== "initial"`).
    if (metaEventName === "subscription_payment_success" && billingReason === "initial") {
      const { data: rpcResult, error: rpcErr } = await supabase.rpc(
        "process_lemon_lifecycle_webhook",
        {
          p_delivery_id: deliveryId,
          p_event_key: eventKey,
          p_event_name: metaEventName,
          p_resource_type: resourceType,
          p_resource_id: resourceId,
          p_store_id: rawStoreId,
          p_test_mode: testModeCheck.isTestEvent,
          p_user_id: UUID_REGEX.test(userId) ? userId : null,
          p_page_id: UUID_REGEX.test(pageId) ? pageId : null,
          p_variant_id: variantId,
          p_order_id: orderId,
          p_subscription_id: subscriptionId,
          p_amount: 0,
          p_refunded_amount: null,
          p_raw_refunded_amount: "",
          p_refund_type: "none",
          p_currency: "USD",
          p_reason: "initial_subscription_invoice_covered_by_order_created",
          p_raw_meta: {
            event_name: metaEventName,
            billing_reason: billingReason,
          },
        },
      );

      if (rpcErr) {
        return json({ error: "database_rpc_error" }, 500);
      }

      const initResultCode = String(rpcResult || "");
      if (initResultCode !== "ok" && initResultCode !== "duplicate_delivery") {
        return json({ error: "database_rpc_error" }, 500);
      }

      return json({
        status: "acknowledged_initial_invoice",
        result: initResultCode,
        subscription_extended: false,
      });
    }

    // =========================================================================
    // CASE 3: Paid Extension Events (`order_created` & renewal `subscription_payment_success`)
    // =========================================================================
    if (
      metaEventName !== "order_created" &&
      metaEventName !== "subscription_payment_success"
    ) {
      return json({
        status: "ignored_unhandled_event",
        event: metaEventName,
        subscription_extended: false,
      });
    }

    // Enforce expected resource type per event:
    // - `order_created` -> `data.type === "orders"`
    // - `subscription_payment_success` -> `data.type === "subscription-invoices"`
    const expectedResourceType =
      metaEventName === "order_created" ? "orders" : "subscription-invoices";

    if (resourceType !== expectedResourceType) {
      return json(
        {
          error: "invalid_resource_type_for_event",
          expected: expectedResourceType,
          received: resourceType,
        },
        400,
      );
    }

    if (status && status !== "paid") {
      return json({
        status: "ignored_non_paid_status",
        payment_status: status,
        subscription_extended: false,
      });
    }

    // Normalize and verify monetary fields strictly from `data.attributes`
    const money = normalizeWebhookMonetaryFields(
      rawBodyString,
      attrs,
      true,
      expectedResourceType,
      resourceId,
    );

    if (!money.valid) {
      return json({ error: money.errorCode }, 400);
    }

    // If fractional minor units exist (e.g. `1859.76` EUR), currency is undocumented (e.g. `KWD`),
    // breakdown fields are missing/inconsistent, or `total_formatted` mismatches:
    // DO NOT extend subscription, DO NOT call `process_lemon_payment_webhook`,
    // DO NOT record a truncated amount as an approved payment, and log a reconciliation issue atomically!
    if (money.requiresReconciliation || money.approvedTotalMinor === null) {
      const reconciliationMeta = {
        event_name: metaEventName,
        reconciliation_reason: money.reconciliationReason,
        provider_total_raw: money.rawTotalString,
        provider_total_formatted: attrs.total_formatted ?? null,
        approved_amount_minor: null,
        unapproved_truncated_minor: money.unapprovedTruncatedMinor,
        subtotal_minor: money.subtotalMinor,
        setup_fee_minor: money.setupFeeMinor,
        discount_minor: money.discountMinor,
        tax_minor: money.taxMinor,
        has_fractional_minor_units: money.hasFractionalMinorUnits,
        fractional_minor_part: money.fractionalMinorPart,
        currency: money.currency,
        currency_exponent: money.currencyExponent,
        is_documented_currency: money.isDocumentedCurrency,
      };

      const { data: reconResult, error: reconErr } = await supabase.rpc(
        "process_lemon_lifecycle_webhook",
        {
          p_delivery_id: deliveryId,
          p_event_key: eventKey,
          p_event_name: metaEventName,
          p_resource_type: resourceType,
          p_resource_id: resourceId,
          p_store_id: rawStoreId,
          p_test_mode: testModeCheck.isTestEvent,
          p_user_id: UUID_REGEX.test(userId) ? userId : null,
          p_page_id: UUID_REGEX.test(pageId) ? pageId : null,
          p_variant_id: variantId,
          p_order_id: orderId,
          p_subscription_id: subscriptionId,
          // Store 0 in the numeric `amount` column so an unapproved/truncated number is NEVER stored as a verified amount
          p_amount: 0,
          p_refunded_amount: null,
          p_raw_refunded_amount: "",
          p_refund_type: "none",
          p_currency: money.currency,
          p_reason: money.reconciliationReason,
          p_raw_meta: reconciliationMeta,
        },
      );

      if (reconErr) {
        return json({ error: "database_rpc_error" }, 500);
      }

      const reconCode = String(reconResult || "");
      if (reconCode !== "ok" && reconCode !== "duplicate_delivery") {
        return json({ error: "database_rpc_error" }, 500);
      }

      return json({
        status: "reconciliation_logged",
        reason: money.reconciliationReason,
        provider_total_raw: money.rawTotalString,
        internal_amount_minor: null,
        unapproved_truncated_minor: money.unapprovedTruncatedMinor,
        currency: money.currency,
        result: reconCode,
        subscription_extended: false,
      });
    }

    const approvedAmountMinor: number = money.approvedTotalMinor;

    // Validate custom_data integrity and user_id presence before attempting to extend subscription
    if (!customDataCheck.ok || !UUID_REGEX.test(userId)) {
      const failureReason = !customDataCheck.ok
        ? customDataCheck.error || "invalid_custom_data"
        : "missing_user_id_in_webhook";

      const { data: reconResult, error: reconErr } = await supabase.rpc(
        "process_lemon_lifecycle_webhook",
        {
          p_delivery_id: deliveryId,
          p_event_key: eventKey,
          p_event_name: metaEventName,
          p_resource_type: resourceType,
          p_resource_id: resourceId,
          p_store_id: rawStoreId,
          p_test_mode: testModeCheck.isTestEvent,
          p_user_id: UUID_REGEX.test(userId) ? userId : null,
          p_page_id: UUID_REGEX.test(pageId) ? pageId : null,
          p_variant_id: variantId,
          p_order_id: orderId,
          p_subscription_id: subscriptionId,
          p_amount: approvedAmountMinor,
          p_refunded_amount: null,
          p_raw_refunded_amount: "",
          p_refund_type: "none",
          p_currency: money.currency,
          p_reason: failureReason,
          p_raw_meta: {
            event_name: metaEventName,
            provider_total_raw: money.rawTotalString,
            internal_amount_minor: approvedAmountMinor,
          },
        },
      );

      if (reconErr) {
        return json({ error: "database_rpc_error" }, 500);
      }

      const reconCode = String(reconResult || "");
      if (reconCode !== "ok" && reconCode !== "duplicate_delivery") {
        return json({ error: "database_rpc_error" }, 500);
      }

      return json({
        status: "reconciliation_logged",
        reason: failureReason,
        result: reconCode,
        subscription_extended: false,
      });
    }

    if (!VARIANT_ID_REGEX.test(variantId)) {
      return json({ error: "invalid_variant_id" }, 400);
    }

    // 7. Execute atomic database payment processing via RPC
    const { data: result, error: rpcError } = await supabase.rpc(
      "process_lemon_payment_webhook",
      {
        p_delivery_id: deliveryId,
        p_event_key: eventKey,
        p_event_name: metaEventName,
        p_resource_type: expectedResourceType,
        p_resource_id: resourceId,
        p_store_id: rawStoreId,
        p_test_mode: testModeCheck.isTestEvent,
        p_user_id: userId,
        p_page_id: UUID_REGEX.test(pageId) ? pageId : null,
        p_variant_id: variantId,
        p_order_id: orderId,
        p_subscription_id: subscriptionId,
        p_amount: approvedAmountMinor,
        p_currency: money.currency,
        p_customer_email: customerEmail,
        p_raw_meta: {
          event_name: metaEventName,
          billing_reason: billingReason,
          status,
          store_id: rawStoreId,
          test_mode: testModeCheck.isTestEvent,
          provider_total_raw: money.rawTotalString,
          provider_total_formatted: attrs.total_formatted ?? null,
          internal_amount_minor: approvedAmountMinor,
          subtotal_minor: money.subtotalMinor,
          setup_fee_minor: money.setupFeeMinor,
          discount_minor: money.discountMinor,
          tax_minor: money.taxMinor,
          currency_exponent: money.currencyExponent,
        },
      },
    );

    if (rpcError) {
      console.error("Database RPC error in process_lemon_payment_webhook:", rpcError.message);
      return json({ error: "database_rpc_error" }, 500);
    }

    const resultCode = String(result || "").trim();

    if (resultCode === "ok") {
      return json({
        status: "processed",
        result: "ok",
        mode: envState.mode,
        internal_amount_minor: approvedAmountMinor,
        currency: money.currency,
        subscription_extended: true,
      });
    }

    if (resultCode === "duplicate" || resultCode === "duplicate_delivery") {
      return json({
        status: "duplicate",
        result: resultCode,
        mode: envState.mode,
        subscription_extended: false,
      });
    }

    if (PRE_COMMIT_REJECTION_CODES.has(resultCode)) {
      return json({ error: resultCode }, 400);
    }

    if (KNOWN_PERSISTED_RECONCILIATION_CODES.has(resultCode)) {
      return json({
        status: "reconciliation_logged",
        result: resultCode,
        mode: envState.mode,
        subscription_extended: false,
      });
    }

    console.error("Unrecognized or empty RPC result in process_lemon_payment_webhook:", resultCode);
    return json({ error: "unexpected_rpc_result" }, 500);
  } catch (err) {
    console.error(
      "Unhandled exception in lemon-webhook:",
      err instanceof Error ? err.message : "unknown",
    );
    return json({ error: "internal_error" }, 500);
  }
});

export {
  extractRawMonetaryTokens,
  convertTokenToMinorUnits,
  normalizeWebhookMonetaryFields,
  OFFICIALLY_DOCUMENTED_LEMON_CURRENCIES,
};
