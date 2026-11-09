import { NextResponse } from "next/server";
import { z } from "zod";
import { onApproved } from "@/lib/escrow";
import { withSession } from "@/lib/session";
import { fail, guard, readSession } from "@/lib/http";

const Body = z.object({ orderId: z.string().regex(/^[A-Z0-9_]{6,40}$/) });

export async function POST(req: Request) {
  const g = guard(req, "authorize", 20); if (g) return g;
  try {
    const { state, body } = await readSession(req);
    const { orderId } = Body.parse(body);
    const out = await withSession(state, () => onApproved(orderId));
    return NextResponse.json({ state: out.state, deals: out.deals, ledger: out.ledger });
  } catch (e) { return fail(e); }
}
