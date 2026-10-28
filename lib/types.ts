export type MilestoneStatus = "draft" | "awaiting_approval" | "funded" | "submitted" | "verified" | "released" | "rejected" | "disputed";

export interface Criterion { id: string; text: string; }
export interface CriterionResult { criterionId: string; pass: boolean; evidence: string; }

export interface Verification {
  verdict: "pass" | "fail";
  confidence: number;
  results: CriterionResult[];
  summary: string;
  model: string;
  at: string;
}

export interface Milestone {
  id: string;
  title: string;
  description: string;
  amount: number; // in currency units, 2 decimals
  criteria: Criterion[];
  status: MilestoneStatus;
  orderId?: string;
  approveUrl?: string;
  authorizationId?: string;
  captureId?: string;
  deliverable?: { url: string; notes: string; submittedAt: string };
  verification?: Verification;
  disputePack?: DisputePack;
}

export interface Deal {
  id: string;
  title: string;
  client: string;
  freelancer: string;
  currency: string;
  scope: string;
  milestones: Milestone[];
  createdAt: string;
}

export interface LedgerEntry {
  id: string;
  at: string;
  dealId: string;
  milestoneId: string;
  milestone: string;
  event: "order_created" | "authorized" | "submitted" | "ai_verified" | "ai_rejected" | "captured" | "voided" | "dispute_opened" | "webhook";
  amount: number;
  currency: string;
  paypalRef: string;
  actor: "client" | "freelancer" | "agent" | "paypal";
  note: string;
}

export interface DisputePack {
  generatedAt: string;
  summary: string;
  timeline: { at: string; event: string }[];
  failedCriteria: CriterionResult[];
  recommendation: string;
  paypalRefs: Record<string, string | undefined>;
}
