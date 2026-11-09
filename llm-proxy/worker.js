// Minimal OpenAI-compatible /v1/chat/completions proxy in front of Cloudflare Workers AI.
// Lets Escrow Agent use a hosted open model (Llama 3.3 70B) through the free Workers AI tier.
// Auth: a long random shared key (Worker secret PROXY_KEY), compared in constant time.
// No CORS, no logging of prompts, fixed model allowlist, request size cap.
const MODELS = new Set(["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct"]);
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(a)), crypto.subtle.digest("SHA-256", enc.encode(b))]);
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0; for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0 && a.length === b.length;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return json({ ok: true });
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") return json({ error: "not found" }, 404);
    const auth = request.headers.get("authorization") || "";
    const key = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!env.PROXY_KEY || env.PROXY_KEY.length < 32 || !(await safeEqual(key, env.PROXY_KEY))) return json({ error: "unauthorized" }, 401);
    const raw = await request.text();
    if (raw.length > 64_000) return json({ error: "too large" }, 413);
    let body; try { body = JSON.parse(raw); } catch { return json({ error: "bad json" }, 400); }
    const model = MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
    const messages = Array.isArray(body.messages) ? body.messages.slice(0, 20).map((m) => ({ role: String(m.role), content: String(m.content).slice(0, 24_000) })) : [];
    if (!messages.length) return json({ error: "messages required" }, 400);
    const input = { messages, temperature: Math.min(Math.max(Number(body.temperature ?? 0.1), 0), 1), max_tokens: Math.min(Number(body.max_tokens ?? 1500), 2500) };
    if (body.response_format?.type === "json_object" || body.response_format?.type === "json_schema") input.response_format = body.response_format;
    try {
      const out = await env.AI.run(model, input);
      const r = out?.response;
      const content = typeof r === "string" ? r : JSON.stringify(r ?? {});
      return json({ id: `chatcmpl-${crypto.randomUUID()}`, object: "chat.completion", model, choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: out?.usage ?? {} });
    } catch (e) {
      return json({ error: "model error", detail: String(e?.message || e).slice(0, 200) }, 502);
    }
  },
};
