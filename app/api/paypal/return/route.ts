import { NextResponse } from "next/server";
import { onApproved } from "@/lib/escrow";
import { paypalMock, config } from "@/lib/config";
import { guard } from "@/lib/http";

// Buyer returns here after approving on PayPal. We authorize (hold) the funds.
export async function GET(req: Request) {
  const g = guard(req, "return", 30); if (g) return g;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!/^[A-Z0-9_]{6,40}$/.test(token)) return NextResponse.redirect(`${config.baseUrl}/?error=bad_token`);
  if (url.searchParams.get("mock") && !paypalMock()) return NextResponse.redirect(`${config.baseUrl}/?error=mock_disabled`);
  try {
    const deal = await onApproved(token);
    return NextResponse.redirect(`${config.baseUrl}/?deal=${deal.id}&funded=1`);
  } catch {
    return NextResponse.redirect(`${config.baseUrl}/?error=authorize_failed`);
  }
}
