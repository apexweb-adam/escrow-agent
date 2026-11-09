import { paypalMock, config } from "@/lib/config";
import { guard } from "@/lib/http";

// Buyer returns here after approving on PayPal. The browser then asks /api/paypal/authorize
// to place the hold, sending its own signed session so the server can match the order.
export async function GET(req: Request) {
  const g = guard(req, "return", 30); if (g) return g;
  const url = new URL(req.url);
  const token = url.searchParams.get("token") ?? "";
  if (!/^[A-Z0-9_]{6,40}$/.test(token)) return Response.redirect(`${config.baseUrl}/?error=bad_token`, 302);
  if (url.searchParams.get("mock") && !paypalMock()) return Response.redirect(`${config.baseUrl}/?error=mock_disabled`, 302);
  return Response.redirect(`${config.baseUrl}/?approved=${token}`, 302);
}
