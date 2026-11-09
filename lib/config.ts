// All secrets are read from the environment only. Never log these values.
// Getters, so values are read at request time (works on Node and on Workers with nodejs_compat).
const env = (k: string) => process.env[k] ?? "";
export const config = {
  get paypalEnv() { return env("PAYPAL_ENV") === "live" ? "live" : "sandbox"; },
  get paypalClientId() { return env("PAYPAL_CLIENT_ID"); },
  get paypalSecret() { return env("PAYPAL_CLIENT_SECRET"); },
  get paypalWebhookId() { return env("PAYPAL_WEBHOOK_ID"); },
  get llmKey() { return env("LLM_API_KEY"); },
  get llmBaseUrl() { return (env("LLM_BASE_URL") || "https://api.openai.com/v1").replace(/\/$/, ""); },
  get llmModel() { return env("LLM_MODEL") || "gpt-4o-mini"; },
  get baseUrl() {
    return (env("APP_BASE_URL")
      || (env("VERCEL_PROJECT_PRODUCTION_URL") ? `https://${env("VERCEL_PROJECT_PRODUCTION_URL")}` : "")
      || "http://localhost:3000").replace(/\/$/, "");
  },
};
export const paypalMock = () => !config.paypalClientId || !config.paypalSecret;
const PAYPAL_HOSTS = new Set(["api-m.paypal.com", "api-m.sandbox.paypal.com"]);
export const paypalApi = () => {
  // Optional PAYPAL_API_BASE override, restricted to the two official PayPal API hosts.
  const o = process.env.PAYPAL_API_BASE;
  if (o) { try { const u = new URL(o); if (u.protocol === "https:" && PAYPAL_HOSTS.has(u.host)) return u.origin; } catch { /* fall through */ } }
  return config.paypalEnv === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
};
