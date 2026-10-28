// Fixed-window in-memory limiter keyed by client IP + route bucket.
const hits = new Map<string, { n: number; reset: number }>();
export function rateLimit(key: string, limit = 30, windowMs = 60_000): { ok: boolean; retryAfter: number } {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return { ok: true, retryAfter: 0 }; }
  h.n++;
  if (hits.size > 10_000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
  return h.n > limit ? { ok: false, retryAfter: Math.ceil((h.reset - now) / 1000) } : { ok: true, retryAfter: 0 };
}
export function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for")?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "local").trim();
}
