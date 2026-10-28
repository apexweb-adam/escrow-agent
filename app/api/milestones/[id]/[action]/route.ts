import { NextResponse } from "next/server";
import { cancel, dispute, fund, release, submitAndVerify } from "@/lib/escrow";
import { IdSchema, SubmitSchema } from "@/lib/validation";
import { fail, guard, readJson } from "@/lib/http";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; action: string }> }) {
  const { id: rawId, action } = await ctx.params;
  const g = guard(req, `ms-${action}`, action === "submit" ? 10 : 30); if (g) return g;
  try {
    const id = IdSchema.parse(rawId);
    switch (action) {
      case "fund": return NextResponse.json(await fund(id));
      case "submit": { const b = SubmitSchema.parse(await readJson(req)); return NextResponse.json({ milestone: await submitAndVerify(id, b.url, b.notes) }); }
      case "release": return NextResponse.json({ milestone: await release(id) });
      case "cancel": return NextResponse.json({ milestone: await cancel(id) });
      case "dispute": return NextResponse.json({ pack: dispute(id) });
      default: return NextResponse.json({ error: "unknown action" }, { status: 404 });
    }
  } catch (e) { return fail(e); }
}
