import { AsyncLocalStorage } from "node:async_hooks";
import type { Deal, LedgerEntry, Milestone } from "./types";
import { newId } from "./id";

// Escrow state. On a serverless host there is no shared memory between requests, so each
// browser session carries its own state as an HMAC-signed token (see lib/session.ts) and the
// request runs against a private copy of it. Outside a request (tests, scripts) a process-wide
// store is used. PayPal stays the source of truth for money: captures re-check the live
// authorization status before moving funds.
export type DB = { deals: Map<string, Deal>; ledger: LedgerEntry[] };
const g = globalThis as unknown as { __escrowDb?: DB };
export const db: DB = g.__escrowDb ?? (g.__escrowDb = { deals: new Map(), ledger: [] });

const als = new AsyncLocalStorage<DB>();
export const cur = (): DB => als.getStore() ?? db;
export const runIn = <T>(state: DB, fn: () => Promise<T>) => als.run(state, fn);

export const MAX_DEALS = 3;
export const MAX_LEDGER = 150;

export function findMilestone(milestoneId: string): { deal: Deal; m: Milestone } | null {
  for (const deal of cur().deals.values()) {
    const m = deal.milestones.find((x) => x.id === milestoneId);
    if (m) return { deal, m };
  }
  return null;
}

export function findByOrder(orderId: string) {
  for (const deal of cur().deals.values()) {
    const m = deal.milestones.find((x) => x.orderId === orderId);
    if (m) return { deal, m };
  }
  return null;
}

export function log(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
  const s = cur();
  const entry = { ...e, id: newId("led"), at: new Date().toISOString() };
  s.ledger.push(entry);
  if (s.ledger.length > MAX_LEDGER) s.ledger.shift();
  return entry;
}
