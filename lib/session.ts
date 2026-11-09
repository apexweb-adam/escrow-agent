import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cur, runIn, MAX_DEALS, type DB } from "./store";
import type { Deal, LedgerEntry } from "./types";
import { EscrowError } from "./errors";

// Signed session state: base64url(JSON) + "." + HMAC-SHA256. The browser can read its own
// state but cannot forge or edit it. STATE_SECRET must be a long random value in production;
// without it a per-process random key is used (fine for a single local server).
const g = globalThis as unknown as { __escrowKey?: Buffer };
function key(): Buffer {
  const s = process.env.STATE_SECRET ?? "";
  if (s.length >= 32) return Buffer.from(s, "utf8");
  return g.__escrowKey ?? (g.__escrowKey = randomBytes(32));
}
const TTL_MS = 7 * 86_400_000;
export const MAX_TOKEN_BYTES = 200_000;

interface Payload { v: 1; exp: number; deals: Deal[]; ledger: LedgerEntry[] }

const mac = (body: string) => createHmac("sha256", key()).update(body).digest("base64url");

export function seal(s: DB): string {
  const deals = [...s.deals.values()].slice(-MAX_DEALS);
  const keep = new Set(deals.map((d) => d.id));
  const p: Payload = { v: 1, exp: Date.now() + TTL_MS, deals, ledger: s.ledger.filter((e) => keep.has(e.dealId)) };
  const body = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  return `${body}.${mac(body)}`;
}

export function open(token: unknown): DB {
  const empty: DB = { deals: new Map(), ledger: [] };
  if (token === undefined || token === null || token === "") return empty;
  if (typeof token !== "string" || token.length > MAX_TOKEN_BYTES) throw new EscrowError("invalid session", 400);
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new EscrowError("invalid session", 400);
  const want = Buffer.from(mac(body)); const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new EscrowError("session signature invalid", 401);
  let p: Payload;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Payload; } catch { throw new EscrowError("invalid session", 400); }
  if (p.v !== 1 || typeof p.exp !== "number" || p.exp < Date.now()) throw new EscrowError("session expired, start a new deal", 401);
  return { deals: new Map(p.deals.map((d) => [d.id, d])), ledger: p.ledger };
}

/** Runs fn against the caller's own verified state and returns the result plus the new sealed state. */
export async function withSession<T>(token: unknown, fn: () => Promise<T>) {
  const state = open(token);
  const result = await runIn(state, fn);
  return { result, ...view(state) };
}

export function view(s: DB = cur()) {
  return { state: seal(s), deals: [...s.deals.values()].reverse(), ledger: s.ledger };
}
