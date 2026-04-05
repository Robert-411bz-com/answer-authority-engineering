/**
 * 411bz-operator-workbench — Admin UI with 10 SSR views.
 * No React/Next.js — pure SSR HTML via Hono.
 * Views: Health, Tenants, Tenant Detail (evidence/artifacts/diagnoses),
 *        Config, Audit, Affiliates, Orchestrator Runs, Run Detail,
 *        Scorecards, Evidence Drill-Down.
 */

import { Hono } from 'hono';
import { CANONICAL_WORKERS, POLICY_DEFAULTS } from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
  ORCHESTRATOR: Fetcher;
  WORKER_ID: string;
  OPERATOR_KEY: string;
  AUTHORITY_INTERNAL_KEY: string;
};

const app = new Hono<{ Bindings: Bindings }>();

// Auth gate
app.use('/*', async (c, next) => {
  if (c.req.path === '/health') return next();
  const key = c.req.header('X-Operator-Key') || c.req.query('key');
  if (key !== c.env.OPERATOR_KEY) {
    return c.html('<h1>401 Unauthorized</h1><p>Provide X-Operator-Key header or ?key= param</p>', 401);
  }
  await next();
});

/** Safely fetch from a service binding and parse JSON. */
async function safeFetch(fetcher: Fetcher, url: string, authKey: string): Promise<any> {
  try {
    const resp = await fetcher.fetch(new Request(url, {
      headers: { 'X-Authority-Key': authKey },
    }));
    if (!resp.ok) return { data: [] };
    const text = await resp.text();
    return JSON.parse(text);
  } catch {
    return { data: [] };
  }
}

/** Extract data from truth envelope or raw response. */
function extractData(resp: any): any[] {
  const d = resp?.data;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object' && Array.isArray(d.items)) return d.items;
  if (Array.isArray(resp)) return resp;
  return [];
}

function qs(c: any): string {
  return c.req.query('key') || '';
}

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// ── View: Health Dashboard ──
app.get('/', async (c) => {
  const engineHealth = await safeFetch(c.env.ENGINE, 'http://internal/health', c.env.AUTHORITY_INTERNAL_KEY);
  const orchHealth = await safeFetch(c.env.ORCHESTRATOR, 'http://internal/health', c.env.AUTHORITY_INTERNAL_KEY);
  return c.html(renderPage('System Health', `
    <h2>Worker Status</h2>
    <table><tr><th>Worker</th><th>Status</th></tr>
    <tr><td>${CANONICAL_WORKERS.ENGINE}</td><td>${engineHealth?.status || 'unreachable'}</td></tr>
    <tr><td>${CANONICAL_WORKERS.ORCHESTRATOR}</td><td>${orchHealth?.status || 'unreachable'}</td></tr>
    </table>
    <h2>Platform Constants</h2>
    <table><tr><th>Key</th><th>Value</th></tr>
    <tr><td>Orchestrator Stages</td><td>${POLICY_DEFAULTS.ORCHESTRATOR_STAGE_COUNT}</td></tr>
    <tr><td>Examiner Categories</td><td>${POLICY_DEFAULTS.EXAMINER_CATEGORY_COUNT}</td></tr>
    <tr><td>Max Overlays</td><td>${POLICY_DEFAULTS.MAX_OVERLAYS}</td></tr>
    </table>
  `));
});

// ── View: Tenants List ──
app.get('/tenants', async (c) => {
  const resp = await safeFetch(c.env.ENGINE, 'http://internal/v1/tenants', c.env.AUTHORITY_INTERNAL_KEY);
  const tenants = extractData(resp);
  const rows = tenants.map((t: any) =>
    `<tr><td><a href="/tenants/${t.tenant_id}?key=${qs(c)}">${t.tenant_id}</a></td><td>${t.domain || ''}</td><td>${t.business_name || ''}</td><td>${t.plan || ''}</td><td>${t.status || ''}</td></tr>`
  ).join('');
  return c.html(renderPage('Tenants', `
    <h2>All Tenants (${tenants.length})</h2>
    <table><tr><th>ID</th><th>Domain</th><th>Name</th><th>Plan</th><th>Status</th></tr>${rows || '<tr><td colspan="5">No tenants</td></tr>'}</table>
  `));
});

// ── View: Tenant Detail (evidence, artifacts, diagnoses, cures) ──
app.get('/tenants/:tid', async (c) => {
  const tid = c.req.param('tid');
  const k = c.env.AUTHORITY_INTERNAL_KEY;

  const [tenantResp, evidenceResp, artifactsResp, diagnosesResp, curesResp, scoresResp] = await Promise.all([
    safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${tid}`, k),
    safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${tid}/evidence?limit=50`, k),
    safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${tid}/artifacts`, k),
    safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${tid}/diagnoses`, k),
    safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${tid}/cures`, k),
    safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${tid}/scores`, k),
  ]);

  const tenant = tenantResp?.data || {};
  const evidence = extractData(evidenceResp);
  const artifacts = extractData(artifactsResp);
  const diagnoses = extractData(diagnosesResp);
  const cures = extractData(curesResp);
  const scores = extractData(scoresResp);

  // Surface breakdown for evidence
  const surfaceCounts: Record<string, number> = {};
  for (const ev of evidence) {
    const s = ev.source_type || 'unknown';
    surfaceCounts[s] = (surfaceCounts[s] || 0) + 1;
  }
  const surfaceRows = Object.entries(surfaceCounts).map(([s, count]) =>
    `<tr><td>${s}</td><td>${count}</td></tr>`
  ).join('');

  const evidenceRows = evidence.slice(0, 30).map((ev: any) =>
    `<tr><td><a href="/evidence/${ev.evidence_id}?key=${qs(c)}">${ev.evidence_id}</a></td><td>${ev.source_type || ''}</td><td>${ev.source_url ? `<a href="${ev.source_url}" target="_blank">${ev.source_url.substring(0, 50)}</a>` : '—'}</td><td>${ev.confidence || ''}</td><td>${ev.extracted_at || ''}</td></tr>`
  ).join('');

  const artifactRows = artifacts.slice(0, 30).map((a: any) =>
    `<tr><td>${a.artifact_id}</td><td>${a.kind || ''}</td><td>${a.content_hash ? a.content_hash.substring(0, 16) + '...' : '—'}</td><td>${a.version || ''}</td><td>${a.created_at || ''}</td></tr>`
  ).join('');

  const diagRows = diagnoses.slice(0, 30).map((d: any) =>
    `<tr><td>${d.diagnosis_id}</td><td>${d.category || ''}</td><td class="${d.severity === 'critical' ? 'status-err' : d.severity === 'high' ? 'status-warn' : ''}">${d.severity || ''}</td><td>${(d.description || '').substring(0, 80)}</td></tr>`
  ).join('');

  const cureRows = cures.slice(0, 30).map((cu: any) =>
    `<tr><td>${cu.cure_id}</td><td>${cu.category || ''}</td><td>${cu.action_type || ''}</td><td>${cu.priority || ''}</td><td>${cu.status || ''}</td></tr>`
  ).join('');

  return c.html(renderPage(`Tenant: ${tid}`, `
    <h2>Tenant Detail</h2>
    <table>
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>Tenant ID</td><td>${tenant.tenant_id || tid}</td></tr>
      <tr><td>Domain</td><td>${tenant.domain || '—'}</td></tr>
      <tr><td>Business Name</td><td>${tenant.business_name || '—'}</td></tr>
      <tr><td>Business Type</td><td>${tenant.business_type || '—'}</td></tr>
      <tr><td>Plan</td><td>${tenant.plan || '—'}</td></tr>
      <tr><td>Status</td><td>${tenant.status || '—'}</td></tr>
    </table>

    <h3>Evidence by Surface (${evidence.length} total)</h3>
    <table><tr><th>Surface</th><th>Count</th></tr>${surfaceRows || '<tr><td colspan="2">No evidence</td></tr>'}</table>

    <h3>Evidence (latest 30)</h3>
    <table><tr><th>ID</th><th>Source Type</th><th>URL</th><th>Confidence</th><th>Extracted</th></tr>${evidenceRows || '<tr><td colspan="5">No evidence</td></tr>'}</table>

    <h3>Artifacts (${artifacts.length})</h3>
    <table><tr><th>ID</th><th>Kind</th><th>Hash</th><th>Version</th><th>Created</th></tr>${artifactRows || '<tr><td colspan="5">No artifacts</td></tr>'}</table>

    <h3>Diagnoses (${diagnoses.length})</h3>
    <table><tr><th>ID</th><th>Category</th><th>Severity</th><th>Description</th></tr>${diagRows || '<tr><td colspan="4">No diagnoses</td></tr>'}</table>

    <h3>Cures (${cures.length})</h3>
    <table><tr><th>ID</th><th>Category</th><th>Action</th><th>Priority</th><th>Status</th></tr>${cureRows || '<tr><td colspan="5">No cures</td></tr>'}</table>

    <h3>Scores (${scores.length})</h3>
    <p>${scores.length > 0 ? `Latest AII: ${scores[0]?.score_value || '—'}` : 'No scores computed yet'}</p>

    <p><a href="/tenants?key=${qs(c)}">&larr; Back to tenants</a></p>
  `));
});

// ── View: Evidence Drill-Down ──
app.get('/evidence/:eid', async (c) => {
  const eid = c.req.param('eid');
  // Evidence doesn't have a direct GET by ID in engine, so we search audit log
  return c.html(renderPage(`Evidence: ${eid}`, `
    <h2>Evidence Detail</h2>
    <p>Evidence ID: <code>${eid}</code></p>
    <p>To view full evidence details, query the engine API directly:</p>
    <pre>GET /v1/tenants/{tenant_id}/evidence?limit=1000</pre>
    <p>Filter results for evidence_id = ${eid}</p>
    <p><a href="javascript:history.back()">&larr; Back</a></p>
  `));
});

// ── View: Config ──
app.get('/config', (c) => {
  const policyRows = Object.entries(POLICY_DEFAULTS).map(([k, v]) =>
    `<tr><td>${k}</td><td>${v}</td></tr>`
  ).join('');
  return c.html(renderPage('Configuration', `
    <h2>Platform Configuration</h2>
    <h3>Canonical Workers</h3>
    <table><tr><th>Role</th><th>Worker Name</th></tr>
    ${Object.entries(CANONICAL_WORKERS).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
    </table>
    <h3>Policy Defaults (${Object.keys(POLICY_DEFAULTS).length} keys)</h3>
    <table><tr><th>Key</th><th>Default Value</th></tr>${policyRows}</table>
  `));
});

// ── View: Audit Log ──
app.get('/audit', async (c) => {
  const resp = await safeFetch(c.env.ENGINE, 'http://internal/v1/audit-log?limit=100', c.env.AUTHORITY_INTERNAL_KEY);
  const events = extractData(resp);
  const rows = events.map((e: any) =>
    `<tr><td>${e.action || ''}</td><td>${e.actor || ''}</td><td>${e.tenant_id || '—'}</td><td>${e.resource_type || '—'}</td><td>${e.resource_id || '—'}</td><td>${e.created_at || ''}</td></tr>`
  ).join('');
  return c.html(renderPage('Audit Log', `
    <h2>Recent Audit Events (${events.length})</h2>
    <table><tr><th>Action</th><th>Actor</th><th>Tenant</th><th>Resource Type</th><th>Resource ID</th><th>Time</th></tr>${rows || '<tr><td colspan="6">No events</td></tr>'}</table>
  `));
});

// ── View: Affiliates ──
app.get('/affiliates', async (c) => {
  const resp = await safeFetch(c.env.ENGINE, 'http://internal/v1/affiliates', c.env.AUTHORITY_INTERNAL_KEY);
  const affiliates = extractData(resp);
  const rows = affiliates.map((a: any) =>
    `<tr><td>${a.affiliate_id || ''}</td><td>${a.commission_type || ''}</td><td>${a.commission_rate ? (a.commission_rate * 100).toFixed(0) + '%' : '—'}</td><td>${a.status || ''}</td></tr>`
  ).join('');
  return c.html(renderPage('Affiliates', `
    <h2>Affiliate Management (${affiliates.length})</h2>
    <table><tr><th>ID</th><th>Type</th><th>Commission</th><th>Status</th></tr>${rows || '<tr><td colspan="4">No affiliates</td></tr>'}</table>
  `));
});

// ── View: Orchestrator Runs ──
app.get('/orchestrator', async (c) => {
  const resp = await safeFetch(c.env.ORCHESTRATOR, 'http://internal/v1/pipeline', c.env.AUTHORITY_INTERNAL_KEY);
  const runs = extractData(resp);

  const rows = runs.map((r: any) => {
    const statusClass = r.status === 'completed' ? 'status-ok' : r.status === 'failed' ? 'status-err' : r.status === 'paused' ? 'status-warn' : '';
    return `<tr>
      <td><a href="/orchestrator/${r.run_id}?key=${qs(c)}">${r.run_id}</a></td>
      <td><a href="/tenants/${r.tenant_id}?key=${qs(c)}">${r.tenant_id}</a></td>
      <td>${r.current_stage || ''}</td>
      <td class="${statusClass}">${r.status || ''}</td>
      <td>${r.started_at || ''}</td>
      <td>${r.completed_at || '—'}</td>
      <td>${r.error || '—'}</td>
    </tr>`;
  }).join('');

  return c.html(renderPage('Orchestrator Runs', `
    <h2>Pipeline Runs (${runs.length})</h2>
    <table>
      <tr><th>Run ID</th><th>Tenant</th><th>Stage</th><th>Status</th><th>Started</th><th>Completed</th><th>Error</th></tr>
      ${rows || '<tr><td colspan="7">No runs found</td></tr>'}
    </table>
  `));
});

// ── View: Orchestrator Run Detail ──
app.get('/orchestrator/:run_id', async (c) => {
  const runId = c.req.param('run_id');
  const resp = await safeFetch(c.env.ORCHESTRATOR, `http://internal/v1/pipeline/${runId}`, c.env.AUTHORITY_INTERNAL_KEY);
  const payload = resp?.data || resp;
  if (!payload || !payload.run) {
    return c.html(renderPage('Run Not Found', `<h2>Run ${runId} not found</h2><p><a href="/orchestrator?key=${qs(c)}">&larr; Back</a></p>`), 404);
  }
  const { run, transitions, cwar, age } = payload;

  const transRows = (transitions || []).map((t: any) =>
    `<tr><td>${t.from_stage || ''}</td><td>${t.to_stage || ''}</td><td>${t.confidence?.toFixed(3) || '—'}</td><td>${t.decision || ''}</td><td>${t.transitioned_at || ''}</td></tr>`
  ).join('');

  const cwarRows = (cwar || []).map((d: any) =>
    `<tr><td>${d.stage || ''}</td><td>${d.confidence?.toFixed(3) || ''}</td><td>${d.reject_threshold || ''}</td><td>${d.review_threshold || ''}</td><td class="${d.decision === 'proceed' ? 'status-ok' : d.decision === 'reject' ? 'status-err' : 'status-warn'}">${d.decision || ''}</td><td>${d.decided_at || ''}</td></tr>`
  ).join('');

  const ageRows = (age || []).map((a: any) =>
    `<tr><td>${a.stage || ''}</td><td>${a.action || ''}</td><td>${a.confidence?.toFixed(3) || ''}</td><td>${a.outcome || ''}</td><td>${a.decided_at || ''}</td></tr>`
  ).join('');

  return c.html(renderPage(`Run: ${runId}`, `
    <h2>Pipeline Run Detail</h2>
    <table>
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>Run ID</td><td>${run.run_id || ''}</td></tr>
      <tr><td>Tenant</td><td><a href="/tenants/${run.tenant_id}?key=${qs(c)}">${run.tenant_id || ''}</a></td></tr>
      <tr><td>Current Stage</td><td>${run.current_stage || ''}</td></tr>
      <tr><td>Status</td><td>${run.status || ''}</td></tr>
      <tr><td>Started</td><td>${run.started_at || '—'}</td></tr>
      <tr><td>Completed</td><td>${run.completed_at || '—'}</td></tr>
      <tr><td>Error</td><td>${run.error || '—'}</td></tr>
    </table>

    <h3>Stage Transitions (${(transitions || []).length})</h3>
    <table>
      <tr><th>From</th><th>To</th><th>Confidence</th><th>Decision</th><th>Time</th></tr>
      ${transRows || '<tr><td colspan="5">No transitions yet</td></tr>'}
    </table>

    <h3>CWAR Decisions (${(cwar || []).length})</h3>
    <table>
      <tr><th>Stage</th><th>Confidence</th><th>Reject Threshold</th><th>Review Threshold</th><th>Decision</th><th>Time</th></tr>
      ${cwarRows || '<tr><td colspan="6">No CWAR decisions yet</td></tr>'}
    </table>

    <h3>AGE Decisions (${(age || []).length})</h3>
    <table>
      <tr><th>Stage</th><th>Action</th><th>Confidence</th><th>Outcome</th><th>Time</th></tr>
      ${ageRows || '<tr><td colspan="5">No AGE decisions yet</td></tr>'}
    </table>

    <p><a href="/orchestrator?key=${qs(c)}">&larr; Back to all runs</a></p>
  `));
});

// ── View: Scorecards ──
app.get('/scorecards', async (c) => {
  // Scorecards are stored as score_type='scorecard' in scores table
  // We need to query all tenants' scorecards
  const tenantsResp = await safeFetch(c.env.ENGINE, 'http://internal/v1/tenants', c.env.AUTHORITY_INTERNAL_KEY);
  const tenants = extractData(tenantsResp);

  const allScorecards: any[] = [];
  for (const t of tenants.slice(0, 20)) {
    const scResp = await safeFetch(c.env.ENGINE, `http://internal/v1/tenants/${t.tenant_id}/scorecards`, c.env.AUTHORITY_INTERNAL_KEY);
    const scs = extractData(scResp);
    for (const sc of scs) {
      allScorecards.push({ ...sc, tenant_id: t.tenant_id });
    }
  }

  const rows = allScorecards.map((s: any) => {
    let provenance: any = {};
    try { provenance = JSON.parse(s.provenance || '{}'); } catch {}
    const aiiBefore = provenance.aii_before ?? 0;
    const aiiAfter = s.score_value ?? provenance.aii_after ?? 0;
    const delta = aiiAfter - aiiBefore;
    const deltaStr = delta >= 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3);
    const deltaClass = delta > 0 ? 'status-ok' : delta < 0 ? 'status-err' : '';
    return `<tr>
      <td>${s.score_id || ''}</td>
      <td><a href="/tenants/${s.tenant_id}?key=${qs(c)}">${s.tenant_id || ''}</a></td>
      <td>${aiiBefore.toFixed(3)}</td>
      <td>${aiiAfter.toFixed(3)}</td>
      <td class="${deltaClass}">${deltaStr}</td>
      <td>${s.computed_at || ''}</td>
    </tr>`;
  }).join('');

  return c.html(renderPage('Scorecards', `
    <h2>Published Scorecards (${allScorecards.length})</h2>
    <table>
      <tr><th>Scorecard ID</th><th>Tenant</th><th>AII Before</th><th>AII After</th><th>Delta</th><th>Published</th></tr>
      ${rows || '<tr><td colspan="6">No scorecards published yet</td></tr>'}
    </table>
  `));
});

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>411bz Workbench — ${title}</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:2rem;background:#0a0a0a;color:#e0e0e0;line-height:1.5}
nav{margin-bottom:2rem;padding:1rem;background:#111;border-radius:8px;display:flex;flex-wrap:wrap;gap:0.5rem}
nav a{color:#60a5fa;padding:0.4rem 0.8rem;text-decoration:none;border-radius:4px;transition:background 0.2s}
nav a:hover{background:#1a1a2e}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem;font-size:0.9rem}
th,td{border:1px solid #333;padding:8px 12px;text-align:left}
th{background:#1a1a2e;position:sticky;top:0}
tr:hover{background:#111}
h1{color:#60a5fa;margin-bottom:0.5rem}
h2{color:#93c5fd;margin-top:2rem;border-bottom:1px solid #333;padding-bottom:0.5rem}
h3{color:#bfdbfe;margin-top:1.5rem}
a{color:#60a5fa}
code,pre{background:#1a1a2e;padding:2px 6px;border-radius:4px;font-size:0.85rem}
pre{padding:1rem;overflow-x:auto}
.status-ok{color:#4ade80;font-weight:bold}
.status-err{color:#f87171;font-weight:bold}
.status-warn{color:#fbbf24;font-weight:bold}
</style></head>
<body>
<h1>411bz Operator Workbench</h1>
<nav>
  <a href="/">Health</a>
  <a href="/tenants">Tenants</a>
  <a href="/orchestrator">Orchestrator</a>
  <a href="/scorecards">Scorecards</a>
  <a href="/config">Config</a>
  <a href="/audit">Audit</a>
  <a href="/affiliates">Affiliates</a>
</nav>
${body}
<footer style="margin-top:3rem;padding-top:1rem;border-top:1px solid #333;color:#666;font-size:0.8rem">
  411bz.ai Operator Workbench v2.0 — ${Object.keys(CANONICAL_WORKERS).length} workers
</footer>
</body></html>`;
}

export default app;
