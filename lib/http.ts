import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { EscrowError } from "./escrow";
import { clientIp, rateLimit } from "./ratelimit";

export function guard(req: Request, bucket: string, limit = 30) {
  const r = rateLimit(`${bucket}:${clientIp(req)}`, limit);
  if (!r.ok) return NextResponse.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(r.retryAfter) } });
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  return null;
}

export function fail(e: unknown) {
  if (e instanceof ZodError) return NextResponse.json({ error: "invalid input", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });
  if (e instanceof EscrowError) return NextResponse.json({ error: e.message }, { status: e.status });
  console.error("[escrow] internal error:", e instanceof Error ? e.message : "unknown");
  return NextResponse.json({ error: "internal error" }, { status: 500 });
}

export async function readJson(req: Request, maxBytes = 20_000): Promise<unknown> {
  const t = await req.text();
  if (t.length > maxBytes) throw new EscrowError("payload too large", 413);
  try { return JSON.parse(t); } catch { throw new EscrowError("invalid JSON", 400); }
}
