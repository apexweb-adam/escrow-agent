"use client";
import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import type { Deal, LedgerEntry, Milestone } from "@/lib/types";
const Ledger = dynamic(() => import("./Ledger"), { ssr: false });

const SAMPLE = `Build a marketing landing page for a coffee subscription startup. Deliver a Figma design with mobile and desktop layouts. Implement the page in Next.js with a responsive hero, pricing table and signup form. Connect the signup form to Mailchimp and add analytics events. Deploy to production with a Lighthouse performance score above 90 and hand over the repository with a README.`;
const ORDER = ["draft", "awaiting_approval", "funded", "submitted", "verified", "released"];

async function api<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.issues?.join("; ") ?? j.error ?? "request failed");
  return j as T;
}

export default function Home() {
  const [deals, setDeals] = useState<Deal[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [mode, setMode] = useState({ paypal: "mock", ai: "mock" });
  const [form, setForm] = useState({ title: "Coffee startup landing page", client: "Brewly Inc.", freelancer: "Dana (freelance dev)", currency: "USD", budget: 2400, scope: SAMPLE });
  const [busy, setBusy] = useState(""); const [err, setErr] = useState("");
  const refresh = useCallback(async () => { const j = await api<{ deals: Deal[]; ledger: LedgerEntry[]; mode: typeof mode }>("/api/deals"); setDeals(j.deals); setLedger(j.ledger); setMode(j.mode); }, []);
  useEffect(() => { refresh().catch(() => {}); }, [refresh]);
  const run = async (key: string, fn: () => Promise<unknown>) => { setBusy(key); setErr(""); try { await fn(); await refresh(); } catch (e) { setErr((e as Error).message); } finally { setBusy(""); } };
  const deal = deals[0];
  const held = deal?.milestones.filter((m) => ["funded", "submitted", "verified", "rejected", "disputed"].includes(m.status)).reduce((a, m) => a + m.amount, 0) ?? 0;
  const paid = deal?.milestones.filter((m) => m.status === "released").reduce((a, m) => a + m.amount, 0) ?? 0;

  return (
    <div className="wrap">
      <header>
        <div className="logo">Escrow<span>Agent</span></div>
        <div><span className={`pill ${mode.paypal !== "mock" ? "on" : ""}`}>PayPal: {mode.paypal}</span><span className={`pill ${mode.ai !== "mock" ? "on" : ""}`}>AI: {mode.ai}</span></div>
      </header>
      <p className="muted" style={{ marginTop: -12, marginBottom: 20 }}>The AI only pays when the work actually passes. Funds are authorized on PayPal per milestone, verified against acceptance criteria, and captured only after your approval.</p>
      <div className="grid2">
        <div className="card">
          <h2>1. Agree the scope</h2>
          <label>Project</label><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <div className="row"><div style={{ flex: 1 }}><label>Client</label><input value={form.client} onChange={(e) => setForm({ ...form, client: e.target.value })} /></div>
            <div style={{ flex: 1 }}><label>Freelancer</label><input value={form.freelancer} onChange={(e) => setForm({ ...form, freelancer: e.target.value })} /></div></div>
          <div className="row"><div style={{ flex: 1 }}><label>Budget</label><input type="number" min={1} value={form.budget} onChange={(e) => setForm({ ...form, budget: Number(e.target.value) })} /></div>
            <div style={{ width: 100 }}><label>Currency</label><select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}><option>USD</option><option>EUR</option><option>GBP</option></select></div></div>
          <label>Agreed scope (from chat, brief or contract)</label><textarea value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} />
          <div className="row" style={{ marginTop: 12 }}><button disabled={!!busy} onClick={() => run("plan", () => api("/api/deals", form))}>{busy === "plan" ? "Planning..." : "Generate milestones with AI"}</button></div>
          {err && <div className="err">{err}</div>}
        </div>
        <div className="card">
          <h2>2. Milestones {deal && <span className="muted">| held {deal.currency} {held.toFixed(2)} | released {deal.currency} {paid.toFixed(2)}</span>}</h2>
          {!deal && <p className="muted">No deal yet. Paste a scope and let the agent draft milestones with objective acceptance criteria.</p>}
          {deal?.milestones.map((m) => <MilestoneCard key={m.id} m={m} cur={deal.currency} busy={busy} run={run} />)}
        </div>
      </div>
      <div className="card" style={{ marginTop: 20 }}><h2>3. Escrow ledger (AG Grid)</h2><Ledger rows={ledger} /></div>
    </div>
  );
}

function MilestoneCard({ m, cur, busy, run }: { m: Milestone; cur: string; busy: string; run: (k: string, f: () => Promise<unknown>) => Promise<void> }) {
  const [url, setUrl] = useState("https://github.com/example/landing/pull/1");
  const [notes, setNotes] = useState("");
  const idx = ORDER.indexOf(m.status);
  const res = new Map(m.verification?.results.map((r) => [r.criterionId, r]));
  const b = (k: string) => busy === `${k}-${m.id}`;
  return (
    <div className="ms">
      <div className="row" style={{ justifyContent: "space-between" }}><h3>{m.title}</h3><div className="row"><span className={`status s-${m.status}`}>{m.status.replace("_", " ")}</span><span className="amt">{cur} {m.amount.toFixed(2)}</span></div></div>
      <div className="steps">{ORDER.map((s, i) => <i key={s} className={i <= idx ? "on" : ""} />)}</div>
      <div className="muted">{m.description}</div>
      <ul className="crit">{m.criteria.map((c) => { const r = res.get(c.id); return <li key={c.id} className={r ? (r.pass ? "pass" : "fail") : ""}>{c.text}{r && <div style={{ fontSize: 12 }}>{r.pass ? "PASS" : "FAIL"}: {r.evidence}</div>}</li>; })}</ul>
      {m.verification && <p className="muted">AI verdict: <b>{m.verification.verdict.toUpperCase()}</b> ({Math.round(m.verification.confidence * 100)}% conf, {m.verification.model}). {m.verification.summary}</p>}
      <div className="row">
        {(m.status === "draft" || m.status === "awaiting_approval") && <button disabled={!!busy} onClick={() => run(`fund-${m.id}`, async () => { const j = await api<{ approveUrl: string }>(`/api/milestones/${m.id}/fund`, {}); window.location.href = j.approveUrl; })}>{b("fund") ? "Creating order..." : "Fund with PayPal"}</button>}
        {(m.status === "funded" || m.status === "rejected") && <>
          <input style={{ flex: 2 }} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Deliverable URL" />
          <textarea style={{ minHeight: 60 }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Freelancer delivery notes: what was done, evidence per criterion" />
          <button disabled={!!busy || !notes} onClick={() => run(`sub-${m.id}`, () => api(`/api/milestones/${m.id}/submit`, { url, notes }))}>{b("sub") ? "AI verifying..." : "Submit for AI verification"}</button>
        </>}
        {m.status === "verified" && <button className="ok" disabled={!!busy} onClick={() => run(`rel-${m.id}`, () => api(`/api/milestones/${m.id}/release`, {}))}>Approve and release (capture)</button>}
        {m.status === "rejected" && <button className="bad" disabled={!!busy} onClick={() => run(`dis-${m.id}`, () => api(`/api/milestones/${m.id}/dispute`, {}))}>Build dispute evidence pack</button>}
        {["funded", "rejected", "disputed"].includes(m.status) && <button className="ghost" disabled={!!busy} onClick={() => run(`can-${m.id}`, () => api(`/api/milestones/${m.id}/cancel`, {}))}>Void hold</button>}
      </div>
      {m.disputePack && <pre>{JSON.stringify(m.disputePack, null, 2)}</pre>}
      {m.captureId && <p className="muted">Captured: {m.captureId}</p>}
    </div>
  );
}
