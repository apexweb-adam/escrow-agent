import { NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/paypal";
import { recordWebhook } from "@/lib/webhooks";
import { guard } from "@/lib/http";

// PayPal webhooks are accepted only after PayPal itself confirms the signature.
export async function POST(req: Request) {
  const g = guard(req, "webhook", 120); if (g) return g;
  const raw = await req.text();
  if (raw.length > 100_000) return NextResponse.json({ error: "too large" }, { status: 413 });
  let ok = false;
  try { ok = await verifyWebhook(req.headers, raw); } catch { ok = false; }
  if (!ok) return NextResponse.json({ error: "signature verification failed" }, { status: 401 });
  const ev = JSON.parse(raw) as { id?: string; event_type?: string };
  const fresh = recordWebhook(String(ev.id ?? ""), String(ev.event_type ?? "unknown"));
  console.log(`[webhook] verified ${String(ev.event_type ?? "unknown").slice(0, 60)}${fresh ? "" : " (duplicate)"}`);
  return NextResponse.json({ ok: true, duplicate: !fresh });
}
