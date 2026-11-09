// Cloudflare Workers entry for the hosted demo. It reuses the exact Next.js route handlers
// (they only use Web Request/Response) and serves the prebuilt static UI from the bundle.
// Build: npm run build && node scripts/build-worker.mjs. Secrets come from Worker secrets only.
import process from "node:process";
import { ASSETS } from "./assets.generated.js";
import * as deals from "../app/api/deals/route";
import * as milestones from "../app/api/milestones/[id]/[action]/route";
import * as authorize from "../app/api/paypal/authorize/route";
import * as ret from "../app/api/paypal/return/route";
import * as status from "../app/api/status/route";
import * as webhook from "../app/api/webhooks/paypal/route";
import { setAiBinding } from "../lib/ai";

const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "connect-src 'self'", "font-src 'self' data:",
  "frame-ancestors 'none'", "base-uri 'self'", "form-action 'self'", "object-src 'none'",
].join("; ");
const SECURITY: Record<string, string> = {
  "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()", "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": CSP, "Cross-Origin-Opener-Policy": "same-origin",
};
const TYPES: Record<string, string> = { js: "application/javascript; charset=utf-8", css: "text/css; charset=utf-8", html: "text/html; charset=utf-8" };

function secure(r: Response): Response {
  const out = new Response(r.body, r);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname;
  const m = req.method;
  if (p === "/" && (m === "GET" || m === "HEAD")) return new Response(ASSETS["/index.html"], { headers: { "content-type": TYPES.html, "cache-control": "no-store" } });
  if (p.startsWith("/_next/static/") && m === "GET") {
    const body = ASSETS[p];
    if (body === undefined) return new Response("not found", { status: 404 });
    return new Response(body, { headers: { "content-type": TYPES[p.split(".").pop() ?? ""] ?? "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" } });
  }
  if (p === "/api/status" && m === "GET") return status.GET(req);
  if (p === "/api/deals" && m === "POST") return deals.POST(req);
  if (p === "/api/paypal/authorize" && m === "POST") return authorize.POST(req);
  if (p === "/api/paypal/return" && m === "GET") return ret.GET(req);
  if (p === "/api/webhooks/paypal" && m === "POST") return webhook.POST(req);
  const ms = p.match(/^\/api\/milestones\/([^/]+)\/([a-z-]+)$/);
  if (ms && m === "POST") return milestones.POST(req, { params: Promise.resolve({ id: decodeURIComponent(ms[1]), action: ms[2] }) });
  if (p === "/healthz") return Response.json({ ok: true });
  return Response.json({ error: "not found" }, { status: 404 });
}

export default {
  async fetch(req: Request, env: Record<string, unknown>): Promise<Response> {
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") process.env[k] = v;
    const ai = env.AI as Parameters<typeof setAiBinding>[0] | undefined;
    if (ai && typeof ai.run === "function") setAiBinding(ai);
    try { return secure(await route(req)); }
    catch { return secure(Response.json({ error: "internal error" }, { status: 500 })); }
  },
};
