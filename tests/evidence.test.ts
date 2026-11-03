import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { parseGitHubUrl, combineCi, collectGitHubEvidence, isCiGated, type GitHubEvidence } from "@/lib/evidence";
import { applyCiGate, mockVerify } from "@/lib/ai";
import { createDeal, fund, onApproved, submitAndVerify, release, deps, holdState, HONOR_PERIOD_MS, AUTH_VALID_MS } from "@/lib/escrow";
import { db } from "@/lib/store";
import type { Milestone } from "@/lib/types";

const SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";

function fakeGitHub(ci: { runs?: { name: string; status: string; conclusion: string | null }[]; statuses?: { context: string; state: string }[] }) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    if (!url.startsWith("https://api.github.com/")) throw new Error("unexpected host " + url);
    const path = url.slice("https://api.github.com".length).split("?")[0];
    const body: Record<string, unknown> = {
      "/repos/acme/site/pulls/7": { head: { sha: SHA } },
      "/repos/acme/site/pulls/7/files": [{ filename: "src/pricing.tsx" }, { filename: "tests/pricing.test.ts" }],
      "/repos/acme/site": { default_branch: "main" },
      "/repos/acme/site/commits/main": { sha: SHA, files: [{ filename: "README.md" }] },
      [`/repos/acme/site/commits/${SHA}/check-runs`]: { check_runs: ci.runs ?? [] },
      [`/repos/acme/site/commits/${SHA}/status`]: { statuses: ci.statuses ?? [] },
    };
    if (!(path in body)) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(body[path]), { status: 200 });
  }) as typeof fetch;
  return { f, calls };
}

describe("GitHub URL parsing (only github.com, validated names)", () => {
  it("accepts repo, PR, commit and tree links", () => {
    expect(parseGitHubUrl("https://github.com/acme/site")).toEqual({ owner: "acme", repo: "site", kind: "repo" });
    expect(parseGitHubUrl("https://github.com/acme/site/pull/7/files")).toMatchObject({ kind: "pull", ref: "7" });
    expect(parseGitHubUrl(`https://github.com/acme/site/commit/${SHA}`)).toMatchObject({ kind: "commit", ref: SHA });
    expect(parseGitHubUrl("https://github.com/acme/site/tree/feature/pricing")).toMatchObject({ kind: "tree", ref: "feature/pricing" });
  });
  it("rejects other hosts, http and traversal", () => {
    expect(parseGitHubUrl("https://evil.example/acme/site")).toBeNull();
    expect(parseGitHubUrl("http://github.com/acme/site")).toBeNull();
    expect(parseGitHubUrl("https://github.com.evil.io/acme/site")).toBeNull();
    expect(parseGitHubUrl("https://github.com/acme/site/tree/..%2F..%2Fx")).toBeNull();
    expect(parseGitHubUrl("https://github.com/acme/site/tree/a/../../b")).toBeNull(); // URL() folds it to /acme/site/b, not a tree link
    expect(parseGitHubUrl("https://github.com/acme")).toBeNull();
  });
});

describe("CI folding", () => {
  it("any failure wins, then pending, else success; nothing means none", () => {
    const ok = { name: "test", status: "completed", conclusion: "success" };
    expect(combineCi([ok], []).ci).toBe("success");
    expect(combineCi([ok, { name: "lint", status: "completed", conclusion: "failure" }], []).ci).toBe("failure");
    expect(combineCi([ok, { name: "e2e", status: "in_progress", conclusion: null }], []).ci).toBe("pending");
    expect(combineCi([ok], [{ context: "vercel", state: "error" }]).ci).toBe("failure");
    expect(combineCi([], []).ci).toBe("none");
  });
});

describe("evidence collection", () => {
  it("resolves a PR to its head sha, files and CI, contacting only api.github.com", async () => {
    const { f, calls } = fakeGitHub({ runs: [{ name: "vitest", status: "completed", conclusion: "success" }] });
    const e = await collectGitHubEvidence("https://github.com/acme/site/pull/7", f);
    expect(e).toMatchObject({ repo: "acme/site", kind: "pull", sha: SHA, ci: "success" });
    expect(e!.files).toContain("tests/pricing.test.ts");
    expect(calls.every((c) => c.startsWith("https://api.github.com/repos/acme/site"))).toBe(true);
  });
  it("resolves a bare repo through its default branch", async () => {
    const { f } = fakeGitHub({ statuses: [{ context: "ci/circleci", state: "pending" }] });
    const e = await collectGitHubEvidence("https://github.com/acme/site", f);
    expect(e).toMatchObject({ kind: "repo", sha: SHA, ci: "pending" });
  });
  it("returns null without any request for non-GitHub links", async () => {
    const { f, calls } = fakeGitHub({});
    expect(await collectGitHubEvidence("https://example.com/pr/1", f)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

const ms = (texts: string[]): Milestone => ({ id: "ms_1", title: "Core build", description: "", amount: 100, status: "funded", criteria: texts.map((t, i) => ({ id: `c${i}`, text: t })) });
const facts = (ci: GitHubEvidence["ci"]): GitHubEvidence => ({ source: "github", repo: "acme/site", kind: "pull", ref: "7", sha: SHA, ci, checks: [{ name: "vitest", state: ci === "success" ? "success" : "failure" }], files: [], fetchedAt: "" });

describe("CI gate (ground truth beats claims)", () => {
  it("classifies test, build and lint criteria as CI gated", () => {
    expect(isCiGated("All unit tests pass")).toBe(true);
    expect(isCiGated("Production build succeeds")).toBe(true);
    expect(isCiGated("Pricing table shows three tiers")).toBe(false);
  });
  it("a freelancer claiming green tests still fails when CI is red", () => {
    const m = ms(["All unit tests pass", "Pricing table shows three tiers"]);
    const claimed = mockVerify(m, "All unit tests pass. Pricing table shows three tiers.");
    expect(claimed.verdict).toBe("pass");
    const gated = applyCiGate(m, claimed, facts("failure"));
    expect(gated.verdict).toBe("fail");
    expect(gated.results[0]).toMatchObject({ pass: false });
    expect(gated.results[0].evidence).toContain("a1b2c3d");
    expect(gated.results[1].pass).toBe(true);
  });
  it("green CI on the exact commit passes the gated criterion", () => {
    const m = ms(["Test suite passes in CI"]);
    const v = applyCiGate(m, mockVerify(m, "nothing useful"), facts("success"));
    expect(v.verdict).toBe("pass");
    expect(v.facts?.sha).toBe(SHA);
  });
  it("gated criteria need a GitHub link at all", () => {
    const m = ms(["All tests pass"]);
    expect(applyCiGate(m, mockVerify(m, "All tests pass"), undefined).verdict).toBe("fail");
  });
});

const scope = "Implement the pricing table in Next.js with three tiers. All unit tests pass in CI. Write a short README section for the pricing table.";
const input = { title: "t", client: "c", freelancer: "f", currency: "USD", budget: 900, scope };

describe("escrow flow with server evidence and PayPal hold lifetime", () => {
  const real = { ...deps };
  beforeEach(() => { db.deals.clear(); db.ledger.length = 0; });
  afterEach(() => { deps.collectEvidence = real.collectEvidence; deps.now = real.now; });

  async function funded() {
    const d = await createDeal(input);
    const m = d.milestones.find((x) => x.criteria.some((c) => isCiGated(c.text)))!;
    await fund(m.id); await onApproved(m.orderId!);
    return m;
  }

  it("rejects a milestone whose PR has red CI even when the notes say it passes", async () => {
    deps.collectEvidence = async () => facts("failure");
    const m = await funded();
    await submitAndVerify(m.id, "https://github.com/acme/site/pull/7", m.criteria.map((c) => c.text).join(". "));
    expect(m.status).toBe("rejected");
    expect(m.verification?.facts?.ci).toBe("failure");
  });

  it("records an evidence fetch error and fails gated criteria instead of crashing", async () => {
    deps.collectEvidence = async () => { throw new Error("GitHub /repos/acme/site failed (403)"); };
    const m = await funded();
    await submitAndVerify(m.id, "https://github.com/acme/site/pull/7", m.criteria.map((c) => c.text).join(". "));
    expect(m.status).toBe("rejected");
    expect(m.verification?.factsError).toContain("403");
  });

  it("reauthorizes once after the 3-day honor period, then captures", async () => {
    let t = Date.parse("2026-11-03T08:00:00Z");
    deps.now = () => t;
    deps.collectEvidence = async () => facts("success");
    const m = await funded();
    expect(holdState(m, t)).toBe("fresh");
    await submitAndVerify(m.id, "https://github.com/acme/site/pull/7", m.criteria.map((c) => c.text).join(". "));
    expect(m.status).toBe("verified");
    t += HONOR_PERIOD_MS + 1;
    expect(holdState(m, t)).toBe("honor_expired");
    await release(m.id);
    expect(m.status).toBe("released");
    expect(m.authorizationId).toMatch(/^MOCKREAUTH_/);
    expect(db.ledger.map((e) => e.event)).toEqual(["order_created", "authorized", "submitted", "ai_verified", "reauthorized", "captured"]);
  });

  it("refuses to capture a hold older than 29 days and sends the milestone back to funding", async () => {
    let t = Date.parse("2026-11-03T08:00:00Z");
    deps.now = () => t;
    deps.collectEvidence = async () => facts("success");
    const m = await funded();
    await submitAndVerify(m.id, "https://github.com/acme/site/pull/7", m.criteria.map((c) => c.text).join(". "));
    t += AUTH_VALID_MS;
    await expect(release(m.id)).rejects.toThrow(/expired after 29 days/);
    expect(m.status).toBe("draft");
    expect(m.authorizationId).toBeUndefined();
  });
});
