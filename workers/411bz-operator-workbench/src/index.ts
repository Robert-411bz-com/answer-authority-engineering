/**
 * 411bz-operator-workbench — Admin UI with 5 SSR views.
 * No React/Next.js — pure SSR HTML via Hono.
 */

import { Hono } from 'hono';
import { CANONICAL_WORKERS } from 'shared-authority-core';

type Bindings = {
  ENGINE: Fetcher;
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
  return c.html(renderPage('System Health', `
    <h2>Worker Status</h2>
    <table><tr><th>Worker</th><th>Status</th></tr>
    <tr><td>${CANONICAL_WORKERS.ENGINE}</td><td>${(engineHealth as {status:string}).status}</td></tr>
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

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>411bz Workbench — ${title}</title>
<style>body{font-family:system-ui;margin:2rem;background:#0a0a0a;color:#e0e0e0}
nav{margin-bottom:2rem}nav a{color:#60a5fa;margin-right:1rem;text-decoration:none}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #333;padding:8px;text-align:left}
th{background:#1a1a2e}h1{color:#60a5fa}</style></head>
<body><h1>411bz Operator Workbench</h1>
<nav><a href="/">Health</a><a href="/tenants">Tenants</a><a href="/config">Config</a><a href="/audit">Audit</a><a href="/affiliates">Affiliates</a></nav>
${body}</body></html>`;
}

export default app;
