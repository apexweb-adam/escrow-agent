// Per-instance record of verified PayPal webhook deliveries. Only event types and times are kept,
// no payer data. Serverless instances are short lived, so this is a best-effort health signal.
const recent: { at: string; type: string }[] = [];
const seen = new Set<string>();
export function recordWebhook(id: string, type: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id); if (seen.size > 2000) seen.clear();
  recent.unshift({ at: new Date().toISOString(), type: type.slice(0, 60) }); recent.length = Math.min(recent.length, 20);
  return true;
}
export const webhookStats = () => ({ verifiedThisInstance: recent.length, recent: recent.slice(0, 5) });
