import { z } from "zod";
const safeText = (max: number) => z.string().trim().min(1).max(max).refine((s) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s), "control characters not allowed");
export const CreateDealSchema = z.object({
  title: safeText(120),
  client: safeText(80),
  freelancer: safeText(80),
  currency: z.enum(["USD", "EUR", "GBP"]).default("USD"),
  budget: z.number().positive().max(50_000),
  scope: safeText(6000).refine((s) => s.length >= 40, "scope must be at least 40 characters"),
});
export const SubmitSchema = z.object({
  url: z.string().trim().url().max(500).refine((u) => /^https?:\/\//i.test(u), "http(s) only"),
  notes: safeText(4000),
});
export const IdSchema = z.string().regex(/^[a-z]{2,4}_[a-f0-9]{12}$/);
export const MilestonePlanSchema = z.object({
  milestones: z.array(z.object({
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(600),
    percent: z.number().min(1).max(100),
    criteria: z.array(z.string().min(3).max(300)).min(1).max(8),
  })).min(1).max(8),
});
export const VerifySchema = z.object({
  verdict: z.enum(["pass", "fail"]),
  confidence: z.number().min(0).max(1),
  summary: z.string().max(1000),
  results: z.array(z.object({ criterionId: z.string(), pass: z.boolean(), evidence: z.string().max(600) })),
});
