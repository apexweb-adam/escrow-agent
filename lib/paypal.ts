import { config, paypalApi, paypalMock } from "./config";
import { newId } from "./id";

// PayPal Orders v2 with intent=AUTHORIZE: buyer approves, we authorize (hold funds),
// then capture only after the AI and the client sign off, or void on cancellation.

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const basic = Buffer.from(`${config.paypalClientId}:${config.paypalSecret}`).toString("base64");
  const r = await fetch(`${paypalApi()}/v1/oauth2/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`PayPal auth failed (${r.status})`);
  const j = (await r.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function pp<T>(path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
  const r = await fetch(`${paypalApi()}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "PayPal-Request-Id": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`PayPal ${path} failed (${r.status}): ${text.slice(0, 300)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export interface CreatedOrder { orderId: string; approveUrl: string; }

export async function createMilestoneOrder(p: { milestoneId: string; title: string; amount: number; currency: string }): Promise<CreatedOrder> {
  if (paypalMock()) {
    const orderId = newId("MOCKORDER").toUpperCase();
    return { orderId, approveUrl: `${config.baseUrl}/api/paypal/return?token=${orderId}&mock=1` };
  }
  const j = await pp<{ id: string; links: { rel: string; href: string }[] }>(
    "/v2/checkout/orders",
    {
      intent: "AUTHORIZE",
      purchase_units: [{
        reference_id: p.milestoneId,
        custom_id: p.milestoneId,
        description: `Escrow milestone: ${p.title}`.slice(0, 127),
        amount: { currency_code: p.currency, value: p.amount.toFixed(2) },
      }],
      payment_source: { paypal: { experience_context: {
        user_action: "CONTINUE",
        shipping_preference: "NO_SHIPPING",
        return_url: `${config.baseUrl}/api/paypal/return`,
        cancel_url: `${config.baseUrl}/?cancelled=1`,
      } } },
    },
    `create-${p.milestoneId}`,
  );
  const approve = j.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
  if (!approve) throw new Error("PayPal did not return an approval link");
  return { orderId: j.id, approveUrl: approve.href };
}

export async function authorizeOrder(orderId: string): Promise<string> {
  if (paypalMock()) return `MOCKAUTH_${orderId.slice(-8)}`;
  const j = await pp<{ purchase_units: { payments: { authorizations: { id: string; status: string }[] } }[] }>(
    `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, {}, `auth-${orderId}`);
  const a = j.purchase_units[0]?.payments?.authorizations?.[0];
  if (!a) throw new Error("No authorization returned");
  return a.id;
}

export async function captureAuthorization(authId: string, milestoneId: string): Promise<string> {
  if (paypalMock()) return `MOCKCAP_${authId.slice(-8)}`;
  const j = await pp<{ id: string }>(`/v2/payments/authorizations/${encodeURIComponent(authId)}/capture`,
    { final_capture: true, note_to_payer: "Milestone verified and released by Escrow Agent" }, `cap-${milestoneId}`);
  return j.id;
}

export async function voidAuthorization(authId: string): Promise<void> {
  if (paypalMock()) return;
  await pp(`/v2/payments/authorizations/${encodeURIComponent(authId)}/void`, undefined, `void-${authId}`);
}

// Webhook signature verification via PayPal's verify-webhook-signature endpoint.
export async function verifyWebhook(headers: Headers, rawBody: string): Promise<boolean> {
  const get = (k: string) => headers.get(k) ?? "";
  const required = ["paypal-transmission-id", "paypal-transmission-time", "paypal-cert-url", "paypal-auth-algo", "paypal-transmission-sig"];
  if (required.some((k) => !get(k))) return false;
  if (paypalMock() || !config.paypalWebhookId) return false; // never trust unsigned events
  let event: unknown;
  try { event = JSON.parse(rawBody); } catch { return false; }
  const j = await pp<{ verification_status: string }>("/v1/notifications/verify-webhook-signature", {
    auth_algo: get("paypal-auth-algo"),
    cert_url: get("paypal-cert-url"),
    transmission_id: get("paypal-transmission-id"),
    transmission_sig: get("paypal-transmission-sig"),
    transmission_time: get("paypal-transmission-time"),
    webhook_id: config.paypalWebhookId,
    webhook_event: event,
  });
  return j.verification_status === "SUCCESS";
}
