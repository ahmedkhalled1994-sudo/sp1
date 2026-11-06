import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function hmacHex(secret: string, payload: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function subscriptionVariantId(subscriptionId: string, apiKey: string) {
  const res = await fetch(`https://api.lemonsqueezy.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Accept: "application/vnd.api+json", Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const variant = data?.data?.attributes?.variant_id;
  return variant ? String(variant) : null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const secret = Deno.env.get("LEMONSQUEEZY_WEBHOOK_SECRET");
    if (!secret) return json({ error: "not_configured" }, 503);

    const raw = await req.text();
    const signature = (req.headers.get("X-Signature") ?? "").toLowerCase();
    if (!signature || !timingSafeEqual(await hmacHex(secret, raw), signature)) {
      return json({ error: "invalid_signature" }, 401);
    }

    const event = JSON.parse(raw);
    const eventName = event?.meta?.event_name;
    const attrs = event?.data?.attributes ?? {};
    const userId = String(event?.meta?.custom_data?.user_id ?? "");

    if (event?.meta?.test_mode === true && Deno.env.get("LEMONSQUEEZY_ALLOW_TEST") !== "true") {
      return json({ ignored: "test_mode" });
    }

    let eventKey: string;
    let variantId: string | null;

    if (eventName === "order_created") {
      if (attrs.status !== "paid") return json({ ignored: "not_paid" });
      eventKey = `order_${event.data.id}`;
      variantId = attrs.first_order_item?.variant_id ? String(attrs.first_order_item.variant_id) : null;
    } else if (eventName === "subscription_payment_success") {
      if (attrs.billing_reason !== "renewal") return json({ ignored: "initial_payment_counted_by_order" });
      const apiKey = Deno.env.get("LEMONSQUEEZY_API_KEY");
      if (!apiKey) return json({ error: "not_configured" }, 503);
      eventKey = `invoice_${event.data.id}`;
      variantId = await subscriptionVariantId(String(attrs.subscription_id), apiKey);
    } else {
      return json({ ignored: eventName ?? "unknown" });
    }

    if (!UUID_RE.test(userId) || !variantId) {
      console.error("Payment missing user or variant", eventKey);
      return json({ ignored: "missing_user_or_variant" });
    }

    const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: result, error } = await admin.rpc("record_lemon_payment", {
      p_event_key: eventKey,
      p_user_id: userId,
      p_variant_id: variantId,
      p_amount: Number(attrs.total) || 0,
      p_currency: String(attrs.currency ?? ""),
    });

    if (error) {
      console.error(error);
      return json({ error: "record_failed" }, 500);
    }

    if (result !== "ok" && result !== "duplicate") console.error("Payment not applied", eventKey, result);
    return json({ result });
  } catch (error) {
    console.error(error);
    return json({ error: "server_error" }, 500);
  }
});
