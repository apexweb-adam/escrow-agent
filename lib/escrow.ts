import { verifyDeliverable, planMilestones } from "./ai";
import { authorizeOrder, captureAuthorization, createMilestoneOrder, reauthorizeAuthorization, voidAuthorization } from "./paypal";
import { collectGitHubEvidence, type GitHubEvidence } from "./evidence";
import { db, findMilestone, log } from "./store";
import { newId } from "./id";
import type { Deal, DisputePack, MilestoneStatus } from "./types";

const DAY = 86_400_000;
export const HONOR_PERIOD_MS = 3 * DAY;   // PayPal honors an authorization for 3 days
export const AUTH_VALID_MS = 29 * DAY;    // and keeps it valid for 29 days

// Swappable in tests; production asks GitHub directly.
export const deps = {
  collectEvidence: (url: string): Promise<GitHubEvidence | null> => collectGitHubEvidence(url),
  now: () => Date.now(),
};

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
    m.authorizedAt = new Date(deps.now()).toISOString();
    m.reauthorizedAt = undefined;
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
  let facts: GitHubEvidence | undefined; let factsError: string | undefined;
  try { facts = (await deps.collectEvidence(url)) ?? undefined; }
  catch (e) { factsError = e instanceof Error ? e.message : "evidence fetch failed"; }
  const v = { ...(await verifyDeliverable(m, url, notes, facts)), ...(factsError ? { factsError } : {}) };
  m.verification = v;
  m.status = v.verdict === "pass" ? "verified" : "rejected";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: v.verdict === "pass" ? "ai_verified" : "ai_rejected", amount: 0, currency: deal.currency, paypalRef: "", actor: "agent", note: v.summary });
  return m;
}

// Human approval gate: the agent recommends, the client confirms release.
export async function release(milestoneId: string) {
  const { deal, m } = need(milestoneId, ["verified"]);
  if (!m.authorizationId) throw new EscrowError("no authorization on file", 409);
  await keepHoldFresh(deal, m);
  m.captureId = await captureAuthorization(m.authorizationId, m.id);
  m.status = "released";
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "captured", amount: m.amount, currency: deal.currency, paypalRef: m.captureId, actor: "client", note: "Released after AI verification + client approval" });
  return m;
}

/** Authorization lifecycle for long milestones: inside 3 days capture as is; days 4 to 29
 *  reauthorize once first; after 29 days the hold is gone and the client must fund again. */
export function holdState(m: { authorizedAt?: string; reauthorizedAt?: string }, now = deps.now()): "fresh" | "honor_expired" | "expired" | "none" {
  if (!m.authorizedAt) return "none";
  const start = Date.parse(m.authorizedAt);
  if (now - start >= AUTH_VALID_MS) return "expired";
  const honorFrom = m.reauthorizedAt ? Date.parse(m.reauthorizedAt) : start;
  return now - honorFrom >= HONOR_PERIOD_MS ? "honor_expired" : "fresh";
}

async function keepHoldFresh(deal: Deal, m: Deal["milestones"][number]) {
  const st = holdState(m);
  if (st === "expired") {
    m.status = "draft"; m.authorizationId = undefined; m.orderId = undefined; m.approveUrl = undefined;
    throw new EscrowError("PayPal authorization expired after 29 days; the client must fund this milestone again", 409);
  }
  if (st !== "honor_expired") return;
  if (m.reauthorizedAt) return; // only one reauthorization allowed; try the capture anyway
  const old = m.authorizationId!;
  m.authorizationId = await reauthorizeAuthorization(old, m.amount, deal.currency);
  m.reauthorizedAt = new Date(deps.now()).toISOString();
  log({ dealId: deal.id, milestoneId: m.id, milestone: m.title, event: "reauthorized", amount: m.amount, currency: deal.currency, paypalRef: m.authorizationId, actor: "agent", note: `Honor period over, reauthorized ${old}` });
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
