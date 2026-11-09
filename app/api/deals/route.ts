import { NextResponse } from "next/server";
import { createDeal } from "@/lib/escrow";
import { withSession } from "@/lib/session";
import { CreateDealSchema } from "@/lib/validation";
import { fail, guard, readSession } from "@/lib/http";

// Creates a deal inside the caller's own signed session (no shared server state).
export async function POST(req: Request) {
  const g = guard(req, "plan", 10); if (g) return g;
  try {
    const { state, body } = await readSession(req);
    const input = CreateDealSchema.parse(body);
    const out = await withSession(state, () => createDeal(input));
    return NextResponse.json({ deal: out.result, state: out.state, deals: out.deals, ledger: out.ledger }, { status: 201 });
  } catch (e) { return fail(e); }
}
