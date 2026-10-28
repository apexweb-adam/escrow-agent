// Real PayPal SANDBOX smoke test. Reads credentials from .env (gitignored).
// Prints only statuses and public ids. Never prints credentials or tokens.
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(new URL("../.env", import.meta.url), "utf8")
    .split("\n").filter((l) => l && !l.startsWith("#") && l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const API = env.PAYPAL_API_BASE || "https://api-m.sandbox.paypal.com";
if (!API.includes("sandbox")) throw new Error("Refusing to run against a non-sandbox base URL");
const step = (name, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " " + extra : ""}`);

async function token() {
  const basic = Buffer.from(`${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`).toString("base64");
  const r = await fetch(`${API}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) { step("oauth token", false, `(http ${r.status})`); process.exit(1); }
  const j = await r.json();
  step("oauth token", Boolean(j.access_token), `(http ${r.status}, expires_in ${j.expires_in}s)`);
  return j.access_token;
}

async function call(t, method, path, body, reqId) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", ...(reqId ? { "PayPal-Request-Id": reqId } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = {}; try { json = text ? JSON.parse(text) : {}; } catch {}
  return { status: r.status, json };
}

const t = await token();
const run = Date.now().toString(36);

// 1) Order create, intent AUTHORIZE, same payload shape as lib/paypal.ts
const created = await call(t, "POST", "/v2/checkout/orders", {
  intent: "AUTHORIZE",
  purchase_units: [{ reference_id: `ms_${run}`, custom_id: `ms_${run}`, description: "Escrow milestone: smoke test",
    amount: { currency_code: "USD", value: "12.50" } }],
  payment_source: { paypal: { experience_context: { user_action: "CONTINUE", shipping_preference: "NO_SHIPPING",
    return_url: "http://localhost:3000/api/paypal/return", cancel_url: "http://localhost:3000/?cancelled=1" } } },
}, `smoke-create-${run}`);
const link = created.json.links?.find((l) => l.rel === "payer-action" || l.rel === "approve");
step("create order (AUTHORIZE, paypal wallet)", created.status === 200 || created.status === 201,
  `(http ${created.status}, status ${created.json.status}, id ${created.json.id}, approval link ${link ? "present" : "missing"})`);
if (link) console.log(`INFO buyer approval URL host: ${new URL(link.href).host}`);

if (created.json.id) {
  const got = await call(t, "GET", `/v2/checkout/orders/${created.json.id}`);
  step("get order", got.status === 200, `(status ${got.json.status})`);
  const auth = await call(t, "POST", `/v2/checkout/orders/${created.json.id}/authorize`, {}, `smoke-auth-${run}`);
  step("authorize without buyer approval is rejected (expected)", auth.status === 422, `(http ${auth.status}, ${auth.json.details?.[0]?.issue ?? ""})`);
}

// 2) Server-side full lifecycle using a sandbox test card (no buyer browser needed)
if (process.argv.includes("--card")) {
  for (const mode of ["capture", "void"]) {
    const o = await call(t, "POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: `card_${mode}_${run}`, amount: { currency_code: "USD", value: "12.50" } }],
      payment_source: { card: { number: "4111111111111111", expiry: "2030-12", security_code: "123", name: "Sandbox Buyer",
        billing_address: { address_line_1: "1 Main St", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US" } } },
    }, `smoke-card-${mode}-${run}`);
    const a = o.json.purchase_units?.[0]?.payments?.authorizations?.[0];
    step(`card order + authorize [${mode}]`, Boolean(a) && a.status === "CREATED",
      `(http ${o.status}, order ${o.json.status}, auth ${a?.id ?? "none"}, ${o.json.details?.[0]?.issue ?? ""})`);
    if (!a) continue;
    if (mode === "capture") {
      const c = await call(t, "POST", `/v2/payments/authorizations/${a.id}/capture`, { final_capture: true }, `smoke-cap-${run}`);
      step("capture authorization", c.status === 201, `(http ${c.status}, ${c.json.status}, capture ${c.json.id})`);
    } else {
      const v = await call(t, "POST", `/v2/payments/authorizations/${a.id}/void`, undefined, `smoke-void-${run}`);
      step("void authorization", v.status === 204, `(http ${v.status})`);
    }
  }
}
