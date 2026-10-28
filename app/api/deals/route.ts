import { NextResponse } from "next/server";
import { createDeal } from "@/lib/escrow";
import { db } from "@/lib/store";
import { aiMock, paypalMock } from "@/lib/config";
import { CreateDealSchema } from "@/lib/validation";
import { fail, guard, readJson } from "@/lib/http";

export async function GET(req: Request) {
  const g = guard(req, "read", 120); if (g) return g;
  return NextResponse.json({ deals: [...db.deals.values()].reverse(), ledger: db.ledger, mode: { paypal: paypalMock() ? "mock" : "sandbox", ai: aiMock() ? "mock" : "llm" } });
}

export async function POST(req: Request) {
  const g = guard(req, "plan", 10); if (g) return g;
  try {
    const input = CreateDealSchema.parse(await readJson(req));
    return NextResponse.json({ deal: await createDeal(input) }, { status: 201 });
  } catch (e) { return fail(e); }
}
