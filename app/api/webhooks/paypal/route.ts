import { NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/paypal";
import { findByOrder, log } from "@/lib/store";
import { guard } from "@/lib/http";

const seen = new Set<string>();

export async function POST(req: Request) {
  const g = guard(req, "webhook", 120); if (g) return g;
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let ok = false;
  try { ok = await verifyWebhook(req.headers, raw); } catch { ok = false; }
  if (!ok) return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  const ev = JSON.parse(raw) as { id: string; event_type: string; resource?: { id?: string; supplementary_data?: { related_ids?: { order_id?: string } } } };
  if (seen.has(ev.id)) return NextResponse.json({ ok: true, duplicate: true });
  seen.add(ev.id);
  const orderId = ev.resource?.supplementary_data?.related_ids?.order_id ?? ev.resource?.id ?? "";
  const f = findByOrder(orderId);
  if (f) log({ dealId: f.deal.id, milestoneId: f.m.id, milestone: f.m.title, event: "webhook", amount: 0, currency: f.deal.currency, paypalRef: ev.resource?.id ?? "", actor: "paypal", note: ev.event_type });
  return NextResponse.json({ ok: true });
}
