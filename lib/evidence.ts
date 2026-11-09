// Server-collected evidence for a deliverable. The freelancer's notes are untrusted text;
// this module asks GitHub directly what the linked code is and whether its CI is green.
// Only api.github.com is ever contacted, with owner/repo/ref validated first (no SSRF).

export type CiState = "success" | "failure" | "pending" | "none";

export interface GitHubEvidence {
  source: "github";
  repo: string;            // owner/name
  kind: "repo" | "pull" | "commit" | "tree";
  ref: string;             // what the URL pointed at (branch, PR number, sha)
  sha: string;             // exact commit the verdict applies to
  ci: CiState;
  checks: { name: string; state: string }[];
  files: string[];         // changed files of the PR, or of the commit the URL resolves to
  fetchedAt: string;
}

export interface ParsedGitHubUrl { owner: string; repo: string; kind: GitHubEvidence["kind"]; ref?: string; }

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,99})$/;
const SHA = /^[0-9a-f]{7,40}$/i;
const REF = /^[A-Za-z0-9._\/-]{1,200}$/;

export function parseGitHubUrl(raw: string): ParsedGitHubUrl | null {
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "https:" || (u.host !== "github.com" && u.host !== "www.github.com")) return null;
  const p = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  if (p.length < 2) return null;
  const [owner, repoRaw] = p;
  const repo = repoRaw.replace(/\.git$/, "");
  if (!NAME.test(owner) || !NAME.test(repo)) return null;
  if (p.length === 2) return { owner, repo, kind: "repo" };
  if (p[2] === "pull" && /^\d{1,9}$/.test(p[3] ?? "")) return { owner, repo, kind: "pull", ref: p[3] };
  if (p[2] === "commit" && SHA.test(p[3] ?? "")) return { owner, repo, kind: "commit", ref: p[3] };
  if (p[2] === "tree" && p.length > 3) {
    const ref = p.slice(3).join("/");
    if (REF.test(ref) && !ref.includes("..")) return { owner, repo, kind: "tree", ref };
  }
  return null;
}

type Fetch = typeof fetch;

async function gh<T>(f: Fetch, path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "escrow-agent", "X-GitHub-Api-Version": "2022-11-28" };
  // Optional read-only token to lift the 60 req/h anonymous limit. Never logged.
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await f(`https://api.github.com${path}`, { headers, signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new Error(`GitHub ${path.split("?")[0]} failed (${r.status})`);
  return (await r.json()) as T;
}

/** Fold check runs and legacy commit statuses into one state. Any failure wins, then pending. */
export function combineCi(runs: { name: string; status: string; conclusion: string | null }[], statuses: { context: string; state: string }[]): { ci: CiState; checks: { name: string; state: string }[] } {
  const checks = [
    ...runs.map((r) => ({ name: r.name, state: r.status !== "completed" ? "pending" : (r.conclusion ?? "pending") })),
    ...statuses.map((s) => ({ name: s.context, state: s.state })),
  ];
  if (checks.length === 0) return { ci: "none", checks };
  const bad = new Set(["failure", "error", "cancelled", "timed_out", "action_required", "startup_failure", "stale"]);
  const ok = new Set(["success", "neutral", "skipped"]);
  if (checks.some((c) => bad.has(c.state))) return { ci: "failure", checks };
  if (checks.every((c) => ok.has(c.state))) return { ci: "success", checks };
  return { ci: "pending", checks };
}

export async function collectGitHubEvidence(url: string, f: Fetch = fetch): Promise<GitHubEvidence | null> {
  const p = parseGitHubUrl(url);
  if (!p) return null;
  const base = `/repos/${p.owner}/${p.repo}`;
  let sha: string; let files: string[] = []; const ref = p.ref ?? "";
  if (p.kind === "pull") {
    const pr = await gh<{ head: { sha: string } }>(f, `${base}/pulls/${p.ref}`);
    sha = pr.head.sha;
    files = (await gh<{ filename: string }[]>(f, `${base}/pulls/${p.ref}/files?per_page=100`)).map((x) => x.filename);
  } else {
    const target = p.kind === "repo" ? (await gh<{ default_branch: string }>(f, base)).default_branch : p.ref!;
    const c = await gh<{ sha: string; files?: { filename: string }[] }>(f, `${base}/commits/${encodeURIComponent(target)}`);
    sha = c.sha;
    files = (c.files ?? []).map((x) => x.filename);
  }
  const [runs, status] = await Promise.all([
    gh<{ check_runs: { name: string; status: string; conclusion: string | null }[] }>(f, `${base}/commits/${sha}/check-runs?per_page=100`),
    gh<{ statuses: { context: string; state: string }[] }>(f, `${base}/commits/${sha}/status`),
  ]);
  const { ci, checks } = combineCi(runs.check_runs, status.statuses);
  return { source: "github", repo: `${p.owner}/${p.repo}`, kind: p.kind, ref: ref || "default branch", sha, ci, checks: checks.slice(0, 30), files: files.slice(0, 50), fetchedAt: new Date().toISOString() };
}

/** Criteria that CI can decide on its own: tests, builds, lint, type checks, pipelines. */
// "Build a landing page" is a task, not a CI claim; only build *outcomes* are gated.
export const isCiGated = (text: string) =>
  /\b(tests?|unit tests?|test suite|ci|pipeline|lint|linter|type ?check|typecheck|compiles?)\b/i.test(text)
  || /\bbuilds?\s+(passes|pass|succeeds?|is green|green|without (errors|warnings)|cleanly)\b/i.test(text)
  || /\b(passing|green|successful|clean|production)\s+builds?\b/i.test(text);

export function describeEvidence(e: GitHubEvidence): string {
  const checks = e.checks.length ? e.checks.map((c) => `${c.name}=${c.state}`).join(", ") : "no checks reported";
  return `GitHub ${e.kind} ${e.repo}@${e.sha.slice(0, 7)}; CI ${e.ci} (${checks}); files: ${e.files.slice(0, 20).join(", ") || "none listed"}`;
}
