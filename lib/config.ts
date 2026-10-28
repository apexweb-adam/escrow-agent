// All secrets are read from the environment only. Never log these values.
export const config = {
  paypalEnv: process.env.PAYPAL_ENV === "live" ? "live" : "sandbox",
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? "",
  paypalSecret: process.env.PAYPAL_CLIENT_SECRET ?? "",
  paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID ?? "",
  llmKey: process.env.LLM_API_KEY ?? "",
  llmBaseUrl: (process.env.LLM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, ""),
  llmModel: process.env.LLM_MODEL ?? "gpt-4o-mini",
  baseUrl: (process.env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/$/, ""),
};
export const paypalMock = () => !config.paypalClientId || !config.paypalSecret;
export const aiMock = () => !config.llmKey;
const PAYPAL_HOSTS = new Set(["api-m.paypal.com", "api-m.sandbox.paypal.com"]);
export const paypalApi = () => {
  // Optional PAYPAL_API_BASE override, restricted to the two official PayPal API hosts.
  const o = process.env.PAYPAL_API_BASE;
  if (o) { try { const u = new URL(o); if (u.protocol === "https:" && PAYPAL_HOSTS.has(u.host)) return u.origin; } catch { /* fall through */ } }
  return config.paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
};
