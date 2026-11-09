import { NextResponse } from "next/server";
import { cancel, dispute, fund, fundWithTestCard, liveStatus, release, submitAndVerify } from "@/lib/escrow";
import { withSession } from "@/lib/session";
import { IdSchema, SubmitSchema } from "@/lib/validation";
import { fail, guard, readSession } from "@/lib/http";

const ACTIONS = new Set(["fund", "fund-card", "submit", "release", "cancel", "dispute", "status"]);

export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id: rawId, action } = await ctx.params;
  if (!ACTIONS.has(action)) return NextResponse.json({ error: "unknown action" }, { status: 404 });
  const g = guard(req, `ms-${action}`, action === "submit" ? 10 : 30); if (g) return g;
  try {
    const id = IdSchema.parse(rawId);
    const { state, body } = await readSession(req);
    const out = await withSession(state, async (): Promise<unknown> => {
      switch (action) {
        case "fund": return fund(id);
        case "fund-card": return { milestone: await fundWithTestCard(id) };
        case "submit": { const b = SubmitSchema.parse(body); return { milestone: await submitAndVerify(id, b.url, b.notes) }; }
        case "release": return { milestone: await release(id) };
        case "cancel": return { milestone: await cancel(id) };
        case "dispute": return { pack: dispute(id) };
        default: return liveStatus(id);
      }
    });
    return NextResponse.json({ ...(out.result as object), state: out.state, deals: out.deals, ledger: out.ledger });
  } catch (e) { return fail(e); }
}
