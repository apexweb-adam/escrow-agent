import { describe, it, expect, beforeAll } from "vitest";
import { createDeal, fund, fundWithTestCard, onApproved, release, submitAndVerify } from "@/lib/escrow";
import { open, seal, withSession } from "@/lib/session";
import { db } from "@/lib/store";

const scope = "Design a Figma mockup with mobile layouts. Implement responsive hero and pricing table in Next.js. Connect signup form to Mailchimp. Deploy with Lighthouse score above 90.";
const input = { title: "t", client: "c", freelancer: "f", currency: "USD", budget: 1000, scope };

beforeAll(() => { process.env.STATE_SECRET = "test-secret-test-secret-test-secret-0123456789"; });

describe("signed session state", () => {
  it("round-trips a full escrow flow across stateless requests", async () => {
    let s = (await withSession(undefined, () => createDeal(input))).state;
    const deal = open(s).deals.values().next().value!;
    const mid = deal.milestones[0].id;
    const f = await withSession(s, () => fund(mid)); s = f.state;
    const orderId = open(s).deals.get(deal.id)!.milestones[0].orderId!;
    s = (await withSession(s, () => onApproved(orderId))).state;
    const ev = deal.milestones[0].criteria.map((c) => c.text).join(". ");
    s = (await withSession(s, () => submitAndVerify(mid, "https://example.com/pr/1", ev))).state;
    const out = await withSession(s, () => release(mid));
    expect(out.deals[0].milestones[0].status).toBe("released");
    expect(out.ledger.map((e) => e.event)).toEqual(["order_created", "authorized", "submitted", "ai_verified", "captured"]);
    expect(db.deals.size).toBe(0); // nothing leaked into the shared process store
  });

  it("rejects a tampered token", async () => {
    const s = (await withSession(undefined, () => createDeal(input))).state;
    const [body, sig] = s.split(".");
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    p.deals[0].milestones[0].status = "verified";
    const forged = `${Buffer.from(JSON.stringify(p)).toString("base64url")}.${sig}`;
    expect(() => open(forged)).toThrow(/signature/);
    expect(() => open(`${body}.AAAA`)).toThrow(/signature/);
    expect(() => open(123)).toThrow(/invalid/);
  });

  it("rejects an expired token", () => {
    const s = seal({ deals: new Map(), ledger: [] });
    const real = Date.now;
    Date.now = () => real() + 8 * 86_400_000;
    try { expect(() => open(s)).toThrow(/expired/); } finally { Date.now = real; }
  });

  it("a second session cannot see or act on another session's milestones", async () => {
    const a = await withSession(undefined, () => createDeal(input));
    const mid = a.deals[0].milestones[0].id;
    await expect(withSession(undefined, () => fund(mid))).rejects.toThrow(/not found/);
  });

  it("caps deals per session and funds with the sandbox test card path", async () => {
    let s: string | undefined;
    for (let i = 0; i < 5; i++) s = (await withSession(s, () => createDeal({ ...input, title: `d${i}` }))).state;
    const st = open(s);
    expect(st.deals.size).toBe(3);
    const d = [...st.deals.values()].at(-1)!;
    const out = await withSession(s, () => fundWithTestCard(d.milestones[0].id));
    expect(out.result.status).toBe("funded");
    expect(out.result.authorizationId).toMatch(/^MOCKAUTH_/);
    expect(new Set(out.ledger.map((e) => e.dealId)).size).toBeLessThanOrEqual(3);
  });
});
