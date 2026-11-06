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

function safeReturnUrl(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin + url.pathname : null;
  } catch {
    return null;
  }
}

const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

function priceToCents(text: unknown): number | null {
  const normalized = String(text ?? "")
    .replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)))
    .replace(/٫/g, ".");
  const match = normalized.match(/\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const cents = Math.round(Number(match[0].replace(",", ".")) * 100);
  return cents > 0 ? cents : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

    const apiKey = Deno.env.get("LEMONSQUEEZY_API_KEY");
    const storeId = Deno.env.get("LEMONSQUEEZY_STORE_ID");
    if (!apiKey || !storeId) return json({ error: "payments_not_configured" }, 503);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const admin = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: userData, error: userError } = await admin.auth.getUser(token);
    const user = userData?.user;
    if (userError || !user) return json({ error: "unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const plan = Number(body?.plan);
    if (![1, 2, 3].includes(plan)) return json({ error: "invalid_plan" }, 400);

    const [{ data: settings }, { data: page }] = await Promise.all([
      admin.from("pricing_settings").select(`plan${plan}_variant_id, plan${plan}_new_price`).eq("id", "global").maybeSingle(),
      admin.from("pages").select("id").eq("user_id", user.id).maybeSingle(),
    ]);

    const row = settings as Record<string, unknown> | null;
    const variantId = String(row?.[`plan${plan}_variant_id`] ?? "").trim();
    const customPrice = priceToCents(row?.[`plan${plan}_new_price`]);
    if (!variantId) return json({ error: "payments_not_configured" }, 503);
    if (!page) return json({ error: "no_page" }, 400);

    const returnUrl = safeReturnUrl(body?.return_url);

    const lsResponse = await fetch("https://api.lemonsqueezy.com/v1/checkouts", {
      method: "POST",
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        data: {
          type: "checkouts",
          attributes: {
            ...(customPrice ? { custom_price: customPrice } : {}),
            checkout_data: {
              email: user.email ?? undefined,
              custom: { user_id: user.id },
            },
            product_options: returnUrl ? { redirect_url: `${returnUrl}?paid=1#success` } : {},
          },
          relationships: {
            store: { data: { type: "stores", id: storeId } },
            variant: { data: { type: "variants", id: variantId } },
          },
        },
      }),
    });

    const lsData = await lsResponse.json().catch(() => null);
    const url = lsData?.data?.attributes?.url;
    if (!lsResponse.ok || typeof url !== "string") {
      console.error("Lemon Squeezy checkout failed", lsResponse.status, JSON.stringify(lsData?.errors ?? lsData));
      return json({ error: "checkout_failed" }, 502);
    }

    return json({ url });
  } catch (error) {
    console.error(error);
    return json({ error: "server_error" }, 500);
  }
});
