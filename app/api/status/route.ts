import { NextResponse } from "next/server";
import { aiMock, config, paypalMock } from "@/lib/config";
import { guard } from "@/lib/http";
import { webhookStats } from "@/lib/webhooks";

// Public, secret-free status for the header pills.
export async function GET(req: Request) {
  const g = guard(req, "read", 120); if (g) return g;
  return NextResponse.json({
    mode: { paypal: paypalMock() ? "mock" : config.paypalEnv, ai: aiMock() ? "mock" : "llm", model: aiMock() ? "deterministic" : config.llmModel },
    testCard: !paypalMock() && config.paypalEnv === "sandbox",
    webhooks: { configured: Boolean(config.paypalWebhookId), ...webhookStats() },
  }, { headers: { "Cache-Control": "no-store" } });
}
