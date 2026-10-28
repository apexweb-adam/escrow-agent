import { NextResponse } from "next/server";
import { db } from "@/lib/store";
import { IdSchema } from "@/lib/validation";
import { fail, guard } from "@/lib/http";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const g = guard(req, "read", 120); if (g) return g;
  try {
    const id = IdSchema.parse((await ctx.params).id);
    const deal = db.deals.get(id);
    return deal ? NextResponse.json({ deal }) : NextResponse.json({ error: "not found" }, { status: 404 });
  } catch (e) { return fail(e); }
}
