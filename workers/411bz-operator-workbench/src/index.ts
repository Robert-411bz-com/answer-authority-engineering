/**
 * 411bz-operator-workbench — Admin UI with 7 SSR views.
 * No React/Next.js — pure SSR HTML via Hono.
 * Views: Health, Tenants, Config, Audit, Affiliates, Orchestrator Runs, Scorecards.
 */

import { Hono } from 'hono';
import { CANONICAL_WORKERS } from 'shared-authority-core';

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

app.get('/health', (c) => c.json({ status: 'healthy', worker: c.env.WORKER_ID }));

// ── View: Health Dashboard ──
app.get('/', async (c) => {
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const engineHealth = await c.env.ENGINE.fetch(new Request('http://internal/health', { headers }))
    .then(r => r.json()).catch(() => ({ status: 'unreachable' }));
  const orchHealth = await c.env.ORCHESTRATOR.fetch(new Request('http://internal/health', { headers }))
    .then(r => r.json()).catch(() => ({ status: 'unreachable' }));
  return c.html(renderPage('System Health', `
    <h2>Worker Status</h2>
    <table><tr><th>Worker</th><th>Status</th></tr>
    <tr><td>${CANONICAL_WORKERS.ENGINE}</td><td>${(engineHealth as {status:string}).status}</td></tr>
    <tr><td>${CANONICAL_WORKERS.ORCHESTRATOR}</td><td>${(orchHealth as {status:string}).status}</td></tr>
    </table>
  `));
});

// ── View: Tenants ──
app.get('/tenants', async (c) => {
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ENGINE.fetch(new Request('http://internal/v1/tenants', { headers }));
  const data = resp.ok ? await resp.json() as { data: Array<{tenant_id:string;domain:string;business_name:string;plan:string;status:string}> } : { data: [] };
  const rows = (data.data || []).map((t) =>
    `<tr><td>${t.tenant_id}</td><td>${t.domain}</td><td>${t.business_name}</td><td>${t.plan}</td><td>${t.status}</td></tr>`
  ).join('');
  return c.html(renderPage('Tenants', `
    <h2>All Tenants</h2>
    <table><tr><th>ID</th><th>Domain</th><th>Name</th><th>Plan</th><th>Status</th></tr>${rows}</table>
  `));
});

// ── View: Config ──
app.get('/config', (c) => {
  return c.html(renderPage('Configuration', `
    <h2>Platform Configuration</h2>
    <p>Workers: ${Object.values(CANONICAL_WORKERS).join(', ')}</p>
  `));
});

// ── View: Audit Log ──
app.get('/audit', async (c) => {
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ENGINE.fetch(new Request('http://internal/v1/audit-log?limit=50', { headers }));
  const data = resp.ok ? await resp.json() as { data: Array<{action:string;actor:string;created_at:string}> } : { data: [] };
  const rows = (data.data || []).map((e) =>
    `<tr><td>${e.action}</td><td>${e.actor}</td><td>${e.created_at}</td></tr>`
  ).join('');
  return c.html(renderPage('Audit Log', `
    <h2>Recent Audit Events</h2>
    <table><tr><th>Action</th><th>Actor</th><th>Time</th></tr>${rows}</table>
  `));
});

// ── View: Affiliates ──
app.get('/affiliates', async (c) => {
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ENGINE.fetch(new Request('http://internal/v1/affiliates', { headers }));
  const data = resp.ok ? await resp.json() as { data: Array<{affiliate_id:string;commission_type:string;commission_rate:number;status:string}> } : { data: [] };
  const rows = (data.data || []).map((a) =>
    `<tr><td>${a.affiliate_id}</td><td>${a.commission_type}</td><td>${(a.commission_rate * 100).toFixed(0)}%</td><td>${a.status}</td></tr>`
  ).join('');
  return c.html(renderPage('Affiliates', `
    <h2>Affiliate Management</h2>
    <table><tr><th>ID</th><th>Type</th><th>Commission</th><th>Status</th></tr>${rows}</table>
  `));
});

// ── View: Orchestrator Runs ──
app.get('/orchestrator', async (c) => {
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ORCHESTRATOR.fetch(new Request('http://internal/v1/pipeline', { headers }));
  const data = resp.ok
    ? await resp.json() as { data: Array<{run_id:string;tenant_id:string;current_stage:string;status:string;started_at:string;completed_at:string|null;error:string|null}> }
    : { data: [] };
  const runs = data.data || [];

  const rows = runs.map((r) => {
    const statusClass = r.status === 'completed' ? 'status-ok' : r.status === 'failed' ? 'status-err' : r.status === 'paused' ? 'status-warn' : '';
    return `<tr>
      <td><a href="/orchestrator/${r.run_id}?key=${c.req.query('key') || ''}">${r.run_id}</a></td>
      <td>${r.tenant_id}</td>
      <td>${r.current_stage}</td>
      <td class="${statusClass}">${r.status}</td>
      <td>${r.started_at || ''}</td>
      <td>${r.completed_at || '—'}</td>
      <td>${r.error || '—'}</td>
    </tr>`;
  }).join('');

  return c.html(renderPage('Orchestrator Runs', `
    <h2>Pipeline Runs</h2>
    <p>Total runs: ${runs.length}</p>
    <table>
      <tr><th>Run ID</th><th>Tenant</th><th>Current Stage</th><th>Status</th><th>Started</th><th>Completed</th><th>Error</th></tr>
      ${rows || '<tr><td colspan="7">No runs found</td></tr>'}
    </table>
  `));
});

// ── View: Orchestrator Run Detail ──
app.get('/orchestrator/:run_id', async (c) => {
  const runId = c.req.param('run_id');
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ORCHESTRATOR.fetch(new Request(`http://internal/v1/pipeline/${runId}`, { headers }));
  if (!resp.ok) {
    return c.html(renderPage('Run Not Found', `<h2>Run ${runId} not found</h2>`), 404);
  }
  const payload = await resp.json() as {
    data: {
      run: {run_id:string;tenant_id:string;current_stage:string;status:string;started_at:string;completed_at:string|null;error:string|null};
      transitions: Array<{from_stage:string;to_stage:string;confidence:number;decision:string;transitioned_at:string}>;
      cwar: Array<{decision_id:string;stage:string;confidence:number;reject_threshold:number;review_threshold:number;decision:string;decided_at:string}>;
      age: Array<{decision_id:string;stage:string;action:string;confidence:number;outcome:string;decided_at:string}>;
    };
  };
  const { run, transitions, cwar, age } = payload.data;

  const transRows = (transitions || []).map((t) =>
    `<tr><td>${t.from_stage}</td><td>${t.to_stage}</td><td>${t.confidence?.toFixed(3) || '—'}</td><td>${t.decision}</td><td>${t.transitioned_at}</td></tr>`
  ).join('');

  const cwarRows = (cwar || []).map((d) =>
    `<tr><td>${d.stage}</td><td>${d.confidence?.toFixed(3)}</td><td>${d.reject_threshold}</td><td>${d.review_threshold}</td><td class="${d.decision === 'proceed' ? 'status-ok' : d.decision === 'reject' ? 'status-err' : 'status-warn'}">${d.decision}</td><td>${d.decided_at}</td></tr>`
  ).join('');

  const ageRows = (age || []).map((a) =>
    `<tr><td>${a.stage}</td><td>${a.action}</td><td>${a.confidence?.toFixed(3)}</td><td>${a.outcome}</td><td>${a.decided_at}</td></tr>`
  ).join('');

  return c.html(renderPage(`Run: ${runId}`, `
    <h2>Pipeline Run Detail</h2>
    <table>
      <tr><th>Field</th><th>Value</th></tr>
      <tr><td>Run ID</td><td>${run.run_id}</td></tr>
      <tr><td>Tenant</td><td>${run.tenant_id}</td></tr>
      <tr><td>Current Stage</td><td>${run.current_stage}</td></tr>
      <tr><td>Status</td><td>${run.status}</td></tr>
      <tr><td>Started</td><td>${run.started_at || '—'}</td></tr>
      <tr><td>Completed</td><td>${run.completed_at || '—'}</td></tr>
      <tr><td>Error</td><td>${run.error || '—'}</td></tr>
    </table>

    <h3>Stage Transitions</h3>
    <table>
      <tr><th>From</th><th>To</th><th>Confidence</th><th>Decision</th><th>Time</th></tr>
      ${transRows || '<tr><td colspan="5">No transitions yet</td></tr>'}
    </table>

    <h3>CWAR Decisions (Confidence-Weighted Action Routing)</h3>
    <table>
      <tr><th>Stage</th><th>Confidence</th><th>Reject Threshold</th><th>Review Threshold</th><th>Decision</th><th>Time</th></tr>
      ${cwarRows || '<tr><td colspan="6">No CWAR decisions yet</td></tr>'}
    </table>

    <h3>AGE Decisions (Authority Governance Engine)</h3>
    <table>
      <tr><th>Stage</th><th>Action</th><th>Confidence</th><th>Outcome</th><th>Time</th></tr>
      ${ageRows || '<tr><td colspan="5">No AGE decisions yet</td></tr>'}
    </table>

    <p><a href="/orchestrator?key=${c.req.query('key') || ''}">&larr; Back to all runs</a></p>
  `));
});

// ── View: Scorecards ──
app.get('/scorecards', async (c) => {
  const headers = { 'X-Authority-Key': c.env.AUTHORITY_INTERNAL_KEY };
  const resp = await c.env.ENGINE.fetch(new Request('http://internal/v1/scorecards', { headers }));
  const data = resp.ok
    ? await resp.json() as { data: Array<{scorecard_id:string;tenant_id:string;run_id:string;aii_before:number;aii_after:number;published_at:string}> }
    : { data: [] };
  const scorecards = data.data || [];

  const rows = scorecards.map((s) => {
    const delta = (s.aii_after - s.aii_before);
    const deltaStr = delta >= 0 ? `+${delta.toFixed(3)}` : delta.toFixed(3);
    const deltaClass = delta > 0 ? 'status-ok' : delta < 0 ? 'status-err' : '';
    return `<tr>
      <td>${s.scorecard_id}</td>
      <td>${s.tenant_id}</td>
      <td>${s.run_id || '—'}</td>
      <td>${s.aii_before?.toFixed(3) || '—'}</td>
      <td>${s.aii_after?.toFixed(3) || '—'}</td>
      <td class="${deltaClass}">${deltaStr}</td>
      <td>${s.published_at || '—'}</td>
      <td><a href="/orchestrator/${s.run_id}?key=${c.req.query('key') || ''}">View Run</a></td>
    </tr>`;
  }).join('');

  return c.html(renderPage('Scorecards', `
    <h2>Published Scorecards</h2>
    <p>Total scorecards: ${scorecards.length}</p>
    <table>
      <tr><th>Scorecard ID</th><th>Tenant</th><th>Run ID</th><th>AII Before</th><th>AII After</th><th>Delta</th><th>Published</th><th>Details</th></tr>
      ${rows || '<tr><td colspan="8">No scorecards published yet</td></tr>'}
    </table>
  `));
});

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>411bz Workbench — ${title}</title>
<style>body{font-family:system-ui;margin:2rem;background:#0a0a0a;color:#e0e0e0}
nav{margin-bottom:2rem}nav a{color:#60a5fa;margin-right:1rem;text-decoration:none}
table{border-collapse:collapse;width:100%;margin-bottom:1.5rem}th,td{border:1px solid #333;padding:8px;text-align:left}
th{background:#1a1a2e}h1{color:#60a5fa}h2{color:#93c5fd;margin-top:1.5rem}h3{color:#bfdbfe;margin-top:1rem}
a{color:#60a5fa}.status-ok{color:#4ade80;font-weight:bold}.status-err{color:#f87171;font-weight:bold}.status-warn{color:#fbbf24;font-weight:bold}
</style></head>
<body><h1>411bz Operator Workbench</h1>
<nav><a href="/">Health</a><a href="/tenants">Tenants</a><a href="/orchestrator">Orchestrator</a><a href="/scorecards">Scorecards</a><a href="/config">Config</a><a href="/audit">Audit</a><a href="/affiliates">Affiliates</a></nav>
${body}</body></html>`;
}

export default app;
