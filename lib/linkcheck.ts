// Server-side verification of evidence links. The freelancer's notes are untrusted, so every
// link they cite is opened by the server before the model may count it as evidence.
// SSRF rules: https only, port 443 only, no credentials in the URL, no IP literals, hosts on an
// allowlist of public hosting / design / docs services, DNS answers must be public addresses
// (checked where DNS is available; Workers cannot reach private networks anyway), every
// redirect hop is re-validated, 6 s timeout, 256 KB read cap, at most 6 links per delivery.

export interface LinkFact {
  url: string;
  ok: boolean;
  reason: string;          // why it failed, or what was confirmed
  host?: string;
  status?: number;
  contentType?: string;
  title?: string;          // page title or oEmbed title
  author?: string;         // oEmbed author, when the service exposes one
  finalUrl?: string;
}

const EXACT = new Set([
  "github.com", "gist.github.com", "raw.githubusercontent.com",
  "figma.com", "www.figma.com",
  "drive.google.com", "docs.google.com",
  "www.loom.com", "loom.com", "www.youtube.com", "youtube.com", "youtu.be",
  "www.npmjs.com", "pypi.org", "codepen.io", "codesandbox.io", "stackblitz.com",
]);
const SUFFIX = [".vercel.app", ".netlify.app", ".onrender.com", ".github.io", ".pages.dev", ".workers.dev", ".web.app", ".firebaseapp.com"];

export const MAX_LINKS = 6;
const TIMEOUT_MS = 6_000;
const MAX_BYTES = 256 * 1024;
const MAX_HOPS = 3;

export function hostAllowed(host: string): boolean {
  const h = host.toLowerCase();
  return EXACT.has(h) || SUFFIX.some((s) => h.endsWith(s) && h.length > s.length);
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export function isPrivateIp(ip: string): boolean {
  const a = ip.toLowerCase();
  if (a.includes(":")) {
    if (a === "::" || a === "::1") return true;
    if (a.startsWith("::ffff:")) return isPrivateIp(a.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a) || a.startsWith("64:ff9b:") || a.startsWith("2001:db8");
  }
  if (!IPV4.test(a)) return true; // unknown format: refuse
  const [x, y] = a.split(".").map(Number);
  // 198.18.0.0/15 is used as fake-IP DNS by some egress proxies; allow it only when explicitly configured.
  const benchmarkOk = process.env.LINKCHECK_ALLOW_PROXY_DNS === "1";
  return x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31)
    || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19) && !benchmarkOk) || (x === 192 && y === 0);
}

/** Static checks that need no network. Returns a failure reason, or null when the URL may be fetched. */
export function urlProblem(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return "not a valid URL"; }
  if (u.protocol !== "https:") return "only https links are accepted";
  if (u.username || u.password) return "links with credentials are refused";
  if (u.port && u.port !== "443") return "non-standard ports are refused";
  const host = u.hostname.toLowerCase();
  if (IPV4.test(host) || host.startsWith("[") || host.includes(":")) return "IP address links are refused";
  if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return "internal hosts are refused";
  if (!hostAllowed(host)) return `host ${host} is not on the evidence allowlist`;
  return null;
}

type Lookup = (host: string) => Promise<string[]>;
async function defaultLookup(host: string): Promise<string[]> {
  try {
    const dns = await import("node:dns/promises");
    const r = await dns.lookup(host, { all: true, verbatim: true });
    return r.map((x) => x.address);
  } catch {
    return []; // no DNS API (Workers): the platform itself blocks private destinations
  }
}

export const linkDeps = { fetch: (u: string, i: RequestInit) => fetch(u, i), lookup: defaultLookup as Lookup };

async function readCapped(r: Response): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  while (n < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value); n += value.byteLength;
  }
  try { await reader.cancel(); } catch { /* already closed */ }
  const all = new Uint8Array(Math.min(n, MAX_BYTES)); let o = 0;
  for (const c of chunks) { const take = Math.min(c.byteLength, all.length - o); all.set(c.subarray(0, take), o); o += take; if (o >= all.length) break; }
  return new TextDecoder().decode(all);
}

const clean = (s: string | undefined, max = 160) => (s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, max);
function pageTitle(html: string): string {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,300})["']/i)?.[1];
  return clean(og ?? html.match(/<title[^>]*>([^<]{1,300})<\/title>/i)?.[1]);
}

/** GET with manual redirects, each hop re-validated (allowlist + DNS). */
async function safeGet(raw: string, accept: string): Promise<{ r: Response; finalUrl: string } | { fail: string }> {
  let url = raw;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    const problem = urlProblem(url);
    if (problem) return { fail: hop > 0 ? `redirects to a refused location: ${problem}` : problem };
    const host = new URL(url).hostname;
    const ips = await linkDeps.lookup(host);
    if (ips.some(isPrivateIp)) return { fail: "host resolves to a private or internal address" };
    let r: Response;
    try {
      r = await linkDeps.fetch(url, { method: "GET", redirect: "manual", headers: { Accept: accept, "User-Agent": "EscrowAgent-EvidenceCheck/1.0" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      return { fail: e instanceof Error && e.name === "TimeoutError" ? "timed out" : "could not be reached" };
    }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get("location");
      if (!loc) return { fail: `redirect (${r.status}) without a location` };
      url = new URL(loc, url).toString();
      if (/\/login|signin|ServiceLogin|accounts\.google\.com/i.test(url)) return { fail: "link is not public (redirects to a sign-in page)" };
      continue;
    }
    return { r, finalUrl: url };
  }
  return { fail: "too many redirects" };
}

async function viaOembed(url: string, endpoint: string, label: string): Promise<LinkFact> {
  const host = new URL(url).hostname;
  const g = await safeGet(`${endpoint}${encodeURIComponent(url)}`, "application/json");
  if ("fail" in g) return { url, ok: false, host, reason: g.fail };
  if (g.r.status !== 200) return { url, ok: false, host, status: g.r.status, reason: `${label} says this file does not exist or is not public (HTTP ${g.r.status})` };
  let j: { title?: string; author_name?: string } = {};
  try { j = JSON.parse(await readCapped(g.r)); } catch { return { url, ok: false, host, reason: `${label} returned an unreadable answer` }; }
  return { url, ok: true, host, status: 200, contentType: "application/json+oembed", title: clean(j.title), author: clean(j.author_name, 80), reason: `public ${label} resource confirmed via oEmbed` };
}

export async function checkLink(raw: string): Promise<LinkFact> {
  const problem = urlProblem(raw);
  if (problem) return { url: raw, ok: false, reason: problem };
  const u = new URL(raw); const host = u.hostname.toLowerCase();
  if (host.endsWith("figma.com")) {
    if (!/^\/(file|design|proto|board)\/[A-Za-z0-9]{10,}/.test(u.pathname)) return { url: raw, ok: false, host, reason: "not a Figma file link" };
    return viaOembed(raw, "https://www.figma.com/api/oembed?url=", "Figma");
  }
  if (host === "youtu.be" || host.endsWith("youtube.com")) return viaOembed(raw, "https://www.youtube.com/oembed?format=json&url=", "YouTube");
  const g = await safeGet(raw, "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5");
  if ("fail" in g) return { url: raw, ok: false, host, reason: g.fail };
  const ct = (g.r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (g.r.status === 401 || g.r.status === 403) return { url: raw, ok: false, host, status: g.r.status, reason: `link is not public (HTTP ${g.r.status})` };
  if (g.r.status !== 200) return { url: raw, ok: false, host, status: g.r.status, reason: `resource not found (HTTP ${g.r.status})` };
  if (!/^(text\/html|application\/xhtml\+xml|application\/json|text\/plain|text\/markdown|application\/pdf|image\/(png|jpeg|gif|webp|svg\+xml))$/.test(ct)) {
    try { await g.r.body?.cancel(); } catch { /* ignore */ }
    return { url: raw, ok: false, host, status: 200, contentType: ct || "unknown", reason: `unexpected content type ${ct || "unknown"}` };
  }
  const body = ct.startsWith("text/html") || ct === "application/xhtml+xml" ? await readCapped(g.r) : "";
  if (!ct.startsWith("text/html")) { try { await g.r.body?.cancel(); } catch { /* ignore */ } }
  const title = body ? pageTitle(body) : "";
  if (/^(sign in|log in|login)\b/i.test(title)) return { url: raw, ok: false, host, status: 200, contentType: ct, title, reason: "link is not public (shows a sign-in page)" };
  return { url: raw, ok: true, host, status: 200, contentType: ct, title, finalUrl: g.finalUrl !== raw ? g.finalUrl : undefined, reason: "public page confirmed" };
}

const URL_RE = /https?:\/\/[^\s<>"')\]]+/gi;
export function extractLinks(url: string, notes: string): string[] {
  const all = [url, ...(notes.match(URL_RE) ?? [])].map((s) => s.replace(/[.,;:!?]+$/, ""));
  return [...new Set(all)].slice(0, MAX_LINKS);
}

export async function checkLinks(url: string, notes: string): Promise<LinkFact[]> {
  return Promise.all(extractLinks(url, notes).map((l) => checkLink(l).catch((): LinkFact => ({ url: l, ok: false, reason: "check failed" }))));
}

export function describeLinks(facts: LinkFact[]): string {
  return facts.map((f) => f.ok
    ? `VERIFIED ${f.url} (HTTP ${f.status}, ${f.contentType}${f.title ? `, title "${f.title}"` : ""}${f.author ? `, by ${f.author}` : ""})`
    : `UNVERIFIED ${f.url}: ${f.reason}. Must NOT count as evidence.`).join("\n");
}
