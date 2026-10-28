import { verifyDeliverable, planMilestones } from "./ai";
import { authorizeOrder, captureAuthorization, createMilestoneOrder, voidAuthorization } from "./paypal";
import { db, findMilestone, log } from "./store";
import { newId } from "./id";
import type { Deal, DisputePack, MilestoneStatus } from "./types";

export class EscrowError extends Error { constructor(msg: string, public status = 400) { super(msg); } }

function need(milestoneId: string, allowed: MilestoneStatus[]) {
  const f = findMilestone(milestoneId);
  if (!f) throw new EscrowError("milestone not found", 404);
  if (!allowed.includes(f.m.status)) throw new EscrowError(`invalid transition from ${f.m.status}`, 409);
  return f;
}

export async function createDeal(i: { title: string; client: string; freelancer: string; currency: string; budget: number; scope: string }): Promise<Deal> {
  const { milestones } = await planMilestones(i.scope, i.budget);
  const deal: Deal = { id: newId("deal"), title: i.title, client: i.client, freelancer: i.freelancer, currency: i.currency, scope: i.scope, milestones, createdAt: new Date().toISOString() };
  db.deals.set(deal.id, deal);
  return deal;
}

export async function fund(milestoneId: string) {
  const { deal, m } = need(milestoneId, ["draft", "awaiting_approval"]);
  const o = await createMilestoneOrder({ milestoneId: m.id, title: m.title, amount: m.amount, currency: deal.currency });
  m.orderId = o.orderId; m.approveUrl = o.approveUrl; m.status = "awaiting_approval";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "order_created", amount: m.amount, currency: deal.currency, paypalRef: o.orderId, actor: "client", note: "Orders v2 intent=AUTHORIZE" });
  return { approveUrl: o.approveUrl };
}

export async function onApproved(orderId: string) {
  for (const deal of db.deals.values()) {
    const m = deal.milestones.find((x) => x.orderId === orderId);
    if (!m) continue;
    if (m.status !== "awaiting_approval") return deal;
    m.authorizationId = await authorizeOrder(orderId);
    m.status = "funded";
    log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "authorized", amount: m.amount, currency: deal.currency, paypalRef: m.authorizationId, actor: "paypal", note: "Funds held on buyer account" });
    return deal;
  }
  throw new EscrowError("order not found", 404);
}

export async function submitAndVerify(milestoneId: string, url: string, notes: string) {
  const { deal, m } = need(milestoneId, ["funded", "rejected"]);
  m.deliverable = { url, notes, submittedAt: new Date().toISOString() };
  m.status = "submitted";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "submitted", amount: 0, currency: deal.currency, paypalRef: "", actor: "freelancer", note: url });
  const v = await verifyDeliverable(m, url, notes);
  m.verification = v;
  m.status = v.verdict === "pass" ? "verified" : "rejected";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: v.verdict === "pass" ? "ai_verified" : "ai_rejected", amount: 0, currency: deal.currency, paypalRef: "", actor: "agent", note: v.summary });
  return m;
}

// Human approval gate: the agent recommends, the client confirms release.
export async function release(milestoneId: string) {
  const { deal, m } = need(milestoneId, ["verified"]);
  if (!m.authorizationId) throw new EscrowError("no authorization on file", 409);
  m.captureId = await captureAuthorization(m.authorizationId, m.id);
  m.status = "released";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "captured", amount: m.amount, currency: deal.currency, paypalRef: m.captureId, actor: "client", note: "Released after AI verification + client approval" });
  return m;
}

export async function cancel(milestoneId: string) {
  const { deal, m } = need(milestoneId, ["funded", "rejected", "disputed"]);
  if (m.authorizationId) await voidAuthorization(m.authorizationId);
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "voided", amount: -m.amount, currency: deal.currency, paypalRef: m.authorizationId ?? "", actor: "client", note: "Authorization voided, funds returned" });
  m.status = "draft"; m.authorizationId = undefined; m.orderId = undefined; m.approveUrl = undefined;
  return m;
}

export function dispute(milestoneId: string): DisputePack {
  const { deal, m } = need(milestoneId, ["rejected", "submitted", "funded"]);
  const timeline = db.ledger.filter((e) => e.milestoneId === m.id).map((e) => ({ at: e.at, event: `${e.event} by ${e.actor}: ${e.note}` }));
  const failed = m.verification?.results.filter((r) => !r.pass) ?? [];
  const pack: DisputePack = {
    generatedAt: new Date().toISOString(),
    summary: `Dispute on "${m.title}" (${deal.currency} ${m.amount.toFixed(2)}) between ${deal.client} and ${deal.freelancer}. ${failed.length} of ${m.criteria.length} acceptance criteria unmet per ${m.verification?.model ?? "no verification"}.`,
    timeline,
    failedCriteria: failed.map((r) => ({ ...r, evidence: `${m.criteria.find((c) => c.id === r.criterionId)?.text}: ${r.evidence}` })),
    recommendation: failed.length ? "Hold funds. Freelancer may resubmit addressing the listed criteria; otherwise void the authorization." : "No failed criteria recorded; consider release.",
    paypalRefs: { orderId: m.orderId, authorizationId: m.authorizationId },
  };
  m.disputePack = pack; m.status = "disputed";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "dispute_opened", amount: 0, currency: deal.currency, paypalRef: m.authorizationId ?? "", actor: "client", note: "Evidence pack generated" });
  return pack;
}
