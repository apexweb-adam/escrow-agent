import type { Deal, LedgerEntry, Milestone } from "./types";
import { newId } from "./id";

// In-memory store (single instance demo). Swap for Postgres in production.
type DB = { deals: Map<string, Deal>; ledger: LedgerEntry[] };
const g = globalThis as unknown as { __escrowDb?: DB };
export const db: DB = g.__escrowDb ?? (g.__escrowDb = { deals: new Map(), ledger: [] });

export function findMilestone(milestoneId: string): { deal: Deal; m: Milestone } | null {
  for (const deal of db.deals.values()) {
    const m = deal.milestones.find((x) => x.id === milestoneId);
    if (m) return { deal, m };
  }
  return null;
}

export function findByOrder(orderId: string) {
  for (const deal of db.deals.values()) {
    const m = deal.milestones.find((x) => x.orderId === orderId);
    if (m) return { deal, m };
  }
  return null;
}

export function log(e: Omit<LedgerEntry, "id" | "at">): LedgerEntry {
  const entry = { ...e, id: newId("led"), at: new Date().toISOString() };
  db.ledger.push(entry);
  if (db.ledger.length > 5000) db.ledger.shift();
  return entry;
}
