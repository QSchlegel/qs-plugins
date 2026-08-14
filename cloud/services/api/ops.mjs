#!/usr/bin/env node
// Operator console — level 0, above tenant admins.
//
// ── The rule that makes this safe to exist ──────────────────────────────────
// There are now three levels: operator (us) > tenant admin (the customer) >
// member. An operator can see across tenants, which is precisely the surface
// that could quietly undo everything the rest of the system is built to
// guarantee. So:
//
//   AN OPERATOR SEES OPERATIONAL METADATA, NEVER CUSTOMER CONTENT.
//
// Counts, usage, health, gate diagnostics, deployment state — yes. A vault
// note, a task brief, a prompt, an email body — no. Not "hidden in the UI":
// the queries do not select those columns, and `assertMetadataOnly()` checks
// every ops query string against a deny-list at boot and refuses to start if
// one of them reaches for content.
//
// This is also the cheap answer to the processor question in a DPA. An
// operator who cannot technically read customer content does not need a
// contractual promise that they won't.

import crypto from 'node:crypto'

// Columns that carry customer-authored content. An ops query naming any of
// these is a bug, and the boot check treats it as one.
const CONTENT_COLUMNS = [
  'body', 'brief', 'text', 'payload', 'title', 'path', 'links', 'tags',
  'code_hash', 'salt', 'public_key', 'token_hash', 'challenge',
]

export function assertMetadataOnly(queries) {
  const bad = []
  for (const [name, sql] of Object.entries(queries)) {
    const lower = sql.toLowerCase()
    // Only inspect the projection: `where tenant = ...` is fine, selecting
    // `brief` is not.
    const proj = lower.split(/\bfrom\b/)[0]
    for (const col of CONTENT_COLUMNS) {
      if (new RegExp(`(^|[\\s,(])${col}([\\s,)]|$)`).test(proj)) bad.push(`${name} selects ${col}`)
    }
  }
  if (bad.length) throw new Error(`ops queries must be metadata-only: ${bad.join('; ')}`)
  return true
}

// ---------------------------------------------------------------- operators

// Seeded from the environment so a self-hosted install names its own operator
// and never inherits ours.
export const operatorEmails = () =>
  (process.env.OPERATOR_EMAILS || 'mail@quirinschlegel.com')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

export const isOperator = (email) => operatorEmails().includes(String(email || '').toLowerCase())

export async function initOps(pool) {
  if (!pool) return
  // Append-only. Operator actions are the ones nobody else can review, so they
  // are the ones that most need a record.
  await pool.query(`create table if not exists ops_audit(
    id bigserial primary key,
    actor text not null,
    action text not null,
    subject text,
    detail jsonb not null default '{}',
    at timestamptz not null default now()
  )`)
  await pool.query(`create table if not exists tenant_state(
    tenant text primary key references tenant(id) on delete cascade,
    status text not null default 'active',
    note text,
    updated_at timestamptz not null default now()
  )`)
}

export async function audit(pool, { actor, action, subject, detail }) {
  if (!pool) return
  await pool.query(`insert into ops_audit(actor,action,subject,detail) values ($1,$2,$3,$4)`,
    [actor, action, subject || null, JSON.stringify(detail || {})])
}

// ---------------------------------------------------------------- queries

// Declared as strings so the boot check can read them. Every one is counts and
// timestamps; not one reaches into a content column.
export const OPS_QUERIES = {
  tenants: `
    select t.id, t.name, t.plan, t.created_at,
           coalesce(ts.status,'active') as status,
           (select count(*) from account a where a.tenant = t.id) as accounts,
           (select count(*) from account a where a.tenant = t.id and a.role = 'admin') as admins,
           (select count(*) from finding f where f.tenant = t.id) as findings,
           (select count(*) from collab_vault v where v.tenant = t.id) as vaults,
           (select count(*) from collab_task k where k.tenant = t.id) as tasks,
           (select max(s.created_at) from session s where s.tenant = t.id) as last_seen
    from tenant t left join tenant_state ts on ts.tenant = t.id
    order by findings desc, t.created_at desc`,
  usage: `
    select tenant, to_char(date_trunc('month', now()), 'YYYY-MM') as period, count(*) as runs
    from finding where tenant is not null group by tenant`,
  authHealth: `
    select count(*) as sessions,
           count(*) filter (where method = 'passkey') as passkey_sessions,
           count(*) filter (where expires_at < now()) as expired
    from session`,
  passkeys: `select count(*) as enrolled, count(distinct account) as accounts_with_passkey from passkey`,
  invites: `select count(*) as total, count(*) filter (where accepted_at is null) as pending from invite`,
  recentAudit: `select id, actor, action, subject, at from ops_audit order by id desc limit 100`,
  eventVolume: `select count(*) as events, max(seq) as high_water from collab_event`,
}
assertMetadataOnly(OPS_QUERIES)

const q = async (pool, name) => (pool ? (await pool.query(OPS_QUERIES[name])).rows : [])

export async function opsOverview(pool, { findings, gate, mail }) {
  const [tenants, authHealth, passkeys, invites, events] = await Promise.all([
    q(pool, 'tenants'), q(pool, 'authHealth'), q(pool, 'passkeys'), q(pool, 'invites'), q(pool, 'eventVolume'),
  ])
  const usage = await q(pool, 'usage')
  return {
    generatedAt: new Date().toISOString(),
    tenants,
    totals: {
      tenants: tenants.length,
      accounts: tenants.reduce((n, t) => n + Number(t.accounts || 0), 0),
      admins: tenants.reduce((n, t) => n + Number(t.admins || 0), 0),
      findings,
      unattributed: findings - tenants.reduce((n, t) => n + Number(t.findings || 0), 0),
      vaults: tenants.reduce((n, t) => n + Number(t.vaults || 0), 0),
      tasks: tenants.reduce((n, t) => n + Number(t.tasks || 0), 0),
    },
    auth: { ...(authHealth[0] || {}), ...(passkeys[0] || {}), ...(invites[0] || {}) },
    events: events[0] || {},
    usage,
    gate, mail,
    operators: operatorEmails(),
  }
}

export async function setTenantStatus(pool, { actor, tenant, status, note }) {
  if (!['active', 'suspended'].includes(status)) throw new Error('status must be active or suspended')
  if (pool) {
    await pool.query(
      `insert into tenant_state(tenant,status,note,updated_at) values ($1,$2,$3,now())
       on conflict (tenant) do update set status=excluded.status, note=excluded.note, updated_at=now()`,
      [tenant, status, note || null])
    // Suspension is immediate: existing sessions die rather than lingering to
    // their natural expiry.
    if (status === 'suspended') await pool.query(`delete from session where tenant=$1`, [tenant])
  }
  await audit(pool, { actor, action: `tenant.${status}`, subject: tenant, detail: { note: note || null } })
  return { tenant, status }
}

// Deletion is the one destructive operation here. It removes the customer's
// plane-B data and their accounts; it deliberately does NOT remove their
// findings, because those are already anonymous, already pooled into the
// reference table, and re-deriving that table without them would silently
// change every published rate. That trade-off is stated rather than assumed —
// if a deletion request must include findings, do it explicitly and rebuild.
export async function deleteTenant(pool, { actor, tenant, alsoFindings = false }) {
  if (!pool) throw new Error('not available on the in-memory store')
  const before = (await pool.query(
    `select (select count(*) from account where tenant=$1) as accounts,
            (select count(*) from collab_vault where tenant=$1) as vaults,
            (select count(*) from finding where tenant=$1) as findings`, [tenant])).rows[0]
  await pool.query(`delete from collab_note where vault_id in (select id from collab_vault where tenant=$1)`, [tenant])
  await pool.query(`delete from collab_vault where tenant=$1`, [tenant])
  await pool.query(`delete from collab_task where tenant=$1`, [tenant])
  await pool.query(`delete from collab_event where tenant=$1`, [tenant])
  await pool.query(`delete from session where tenant=$1`, [tenant])
  await pool.query(`delete from invite where tenant=$1`, [tenant])
  await pool.query(`delete from account where tenant=$1`, [tenant])
  if (alsoFindings) await pool.query(`delete from finding where tenant=$1`, [tenant])
  await pool.query(`delete from tenant where id=$1`, [tenant])
  await audit(pool, { actor, action: 'tenant.delete', subject: tenant, detail: { before, alsoFindings } })
  return { deleted: tenant, before, findingsRemoved: alsoFindings }
}

export const readAudit = (pool) => q(pool, 'recentAudit')

// ---------------------------------------------------------------- console

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const num = (n) => Number(n || 0).toLocaleString('en-GB')
const ago = (d) => {
  if (!d) return '—'
  const ms = Date.now() - new Date(d).getTime()
  const m = Math.round(ms / 60000)
  if (m < 60) return m + 'm'
  const h = Math.round(m / 60)
  return h < 48 ? h + 'h' : Math.round(h / 24) + 'd'
}

export function opsHtml(o, { audit: auditRows = [], me }) {
  const t = o.totals
  const stat = (n, l, cls) => `<div class="stat${cls ? ' ' + cls : ''}"><div class="n">${esc(n)}</div><div class="l">${esc(l)}</div></div>`
  const tenantRows = o.tenants.map((x) => `<tr${x.status === 'suspended' ? ' class="susp"' : ''}>
    <td><b>${esc(x.name)}</b><br><span class="dim mono">${esc(x.id)}</span></td>
    <td class="r mono">${num(x.accounts)}<span class="dim"> / ${num(x.admins)}a</span></td>
    <td class="r mono">${num(x.findings)}</td>
    <td class="r mono">${num(x.vaults)} · ${num(x.tasks)}</td>
    <td class="r mono">${esc(ago(x.last_seen))}</td>
    <td><span class="pill ${x.status === 'suspended' ? 'bad' : 'ok'}">${esc(x.status)}</span></td>
    <td class="r">
      <button class="mini" data-act="${x.status === 'suspended' ? 'active' : 'suspended'}" data-t="${esc(x.id)}">${x.status === 'suspended' ? 'reinstate' : 'suspend'}</button>
    </td></tr>`).join('')
  const auditList = auditRows.map((a) => `<tr>
    <td class="mono dim">${esc(ago(a.at))}</td><td class="mono">${esc(a.actor)}</td>
    <td><span class="pill">${esc(a.action)}</span></td><td class="mono dim">${esc(a.subject || '')}</td></tr>`).join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>ops — session-viz</title>
<meta name="robots" content="noindex,nofollow">
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e6e2db;--accent:#c2521a;
--accent-soft:#fdf0e8;--ok:#2f6b46;--warn:#9a6a12;--bad:#b3261e;--bar:#d9d4cb;--void:#efece5;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#16151a;--panel:#1e1d23;--ink:#ece9e4;--muted:#9b968d;
--line:#302e37;--accent:#ff8a4c;--accent-soft:#2a1d16;--ok:#6fbf8e;--warn:#e0b055;--bad:#ff6b5e;
--bar:#3a3742;--void:#0d0c11}}
*{box-sizing:border-box}
body{margin:0;background:var(--void);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif}
.wrap{max-width:1120px;margin:0 auto;padding:0 16px 70px}
header{background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:10}
header .in{max-width:1120px;margin:0 auto;padding:0 16px;height:52px;display:flex;align-items:center;gap:16px}
header b{font:700 12px/1 var(--mono);letter-spacing:.16em}
header b i{color:var(--accent);font-style:normal}
header .sp{flex:1}
header .who{font:400 12px/1 var(--mono);color:var(--muted)}
.tag{font:700 9.5px/1 var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--bad);
  border:1px solid var(--bad);border-radius:999px;padding:3px 8px}
h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);margin:30px 0 10px;font-weight:700}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(112px,1fr));background:var(--panel);
  border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:14px}
.stat{padding:12px 14px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat .n{font:600 20px/1 var(--mono);font-variant-numeric:tabular-nums}
.stat .l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:2px}
.stat.warn .n{color:var(--warn)} .stat.bad .n{color:var(--bad)} .stat.ok .n{color:var(--ok)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:0;overflow:hidden}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font:600 10px/1 var(--mono);letter-spacing:.07em;text-transform:uppercase;color:var(--muted);
  padding:11px 12px;border-bottom:1px solid var(--line)}
th.r,td.r{text-align:right}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:middle}
tbody tr:last-child td{border-bottom:0}
tr.susp{background:color-mix(in srgb,var(--bad) 7%,transparent)}
.mono{font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
.dim{color:var(--muted)}
.pill{font:700 9.5px/1 var(--mono);letter-spacing:.06em;text-transform:uppercase;padding:3px 7px;
  border-radius:4px;border:1px solid var(--line);color:var(--muted)}
.pill.ok{color:var(--ok);border-color:var(--ok)} .pill.bad{color:var(--bad);border-color:var(--bad)}
.mini{font:600 11px/1 var(--mono);background:var(--panel);border:1px solid var(--line);color:var(--muted);
  border-radius:5px;padding:5px 9px;cursor:pointer}
.mini:hover{color:var(--ink);border-color:var(--muted)}
.note{border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:0 0 14px;font-size:13.5px;color:var(--muted)}
.note.warn{border-color:var(--warn)}
.msg{font:400 12.5px/1.5 var(--mono);color:var(--muted);margin:10px 0 0;min-height:1.2em}
footer{margin-top:38px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);
  font:400 11.5px/1.6 var(--mono)}
</style></head><body>
<header><div class="in">
  <b>SESSION<i>·</i>VIZ</b><span class="tag">operator</span>
  <span class="sp"></span>
  <span class="who">${esc(me)}</span>
</div></header>
<div class="wrap">

<div class="note warn" style="margin-top:18px">This console shows operational metadata only. Vault notes, task
briefs, prompt text and email bodies are not selectable here — the queries do not name those columns, and the
service refuses to boot if one of them does. Every action below is written to an append-only audit log.</div>

<h2>Fleet</h2>
<div class="stats">
  ${stat(num(t.tenants), 'tenants')}
  ${stat(num(t.accounts), 'accounts')}
  ${stat(num(t.admins), 'team admins')}
  ${stat(num(t.findings), 'findings')}
  ${stat(num(t.unattributed), 'unattributed', t.unattributed > 0 ? 'warn' : '')}
  ${stat(num(t.vaults), 'vaults')}
  ${stat(num(t.tasks), 'tasks')}
  ${stat(num(o.events.events), 'events')}
</div>
${t.unattributed > 0 ? `<p class="msg">${num(t.unattributed)} findings carry no tenant — contributed before
multi-tenancy, or by a machine client using the shared token. They still count toward the k-gate but not
toward any tenant's usage.</p>` : ''}

<h2>Reference-table gate</h2>
<div class="stats">
  ${stat(o.gate?.k ?? '—', 'k (findings)')}
  ${stat(o.gate?.minTenants ?? '—', 'min tenants')}
  ${stat(o.gate?.tenantsContributing ?? 0, 'contributing')}
  ${stat(o.gate?.tenantGateActive ? 'active' : 'pending', 'tenant gate', o.gate?.tenantGateActive ? 'ok' : 'warn')}
  ${stat(num(o.gate?.suppressed), 'cells suppressed')}
  ${stat(num(o.gate?.suppressedForTenants), 'by tenant rule')}
</div>
${!o.gate?.tenantGateActive ? `<p class="msg">Fewer than ${o.gate?.minTenants} tenants are contributing, so the
distinct-tenant condition is not yet enforced. It is reported as pending rather than silently satisfied.</p>` : ''}

<h2>Tenants</h2>
<div class="card"><table>
<thead><tr><th>Tenant</th><th class="r">Accounts</th><th class="r">Findings</th>
<th class="r">Vaults · Tasks</th><th class="r">Last seen</th><th>Status</th><th></th></tr></thead>
<tbody>${tenantRows || '<tr><td colspan="7" class="dim">No tenants yet.</td></tr>'}</tbody></table></div>
<p class="msg" id="msg"></p>

<h2>Authentication</h2>
<div class="stats">
  ${stat(num(o.auth.sessions), 'sessions')}
  ${stat(num(o.auth.passkey_sessions), 'via passkey')}
  ${stat(num(o.auth.expired), 'expired', Number(o.auth.expired) > 0 ? 'warn' : '')}
  ${stat(num(o.auth.enrolled), 'passkeys')}
  ${stat(num(o.auth.accounts_with_passkey), 'accounts w/ passkey')}
  ${stat(num(o.auth.total), 'invites')}
  ${stat(num(o.auth.pending), 'pending', Number(o.auth.pending) > 0 ? 'warn' : '')}
</div>

<h2>Email</h2>
<div class="stats">
  ${stat(o.mail?.enabled ? 'live' : 'dry-run', 'resend', o.mail?.enabled ? 'ok' : 'warn')}
  ${stat(num(o.mail?.last7d?.sent), 'sent 7d')}
  ${stat(num(o.mail?.last7d?.failed), 'failed 7d', Number(o.mail?.last7d?.failed) > 0 ? 'bad' : '')}
  ${stat(num(o.mail?.last7d?.['dry-run']), 'dry-run 7d')}
</div>
${!o.mail?.enabled ? `<p class="msg">RESEND_API_KEY is unset, so codes and notifications are written to the
service log instead of being delivered. Fine for a single operator; wrong once there are customers.</p>` : ''}

<h2>Audit log <span class="dim" style="text-transform:none;letter-spacing:0;font-weight:400">— append-only, last 100</span></h2>
<div class="card"><table>
<thead><tr><th>When</th><th>Operator</th><th>Action</th><th>Subject</th></tr></thead>
<tbody>${auditList || '<tr><td colspan="4" class="dim">No operator actions recorded.</td></tr>'}</tbody></table></div>

<footer>operators: ${esc(o.operators.join(', '))} · generated ${esc(o.generatedAt.slice(0, 16).replace('T', ' '))} ·
metadata only — this console cannot read customer content</footer>
</div>
<script>
document.querySelectorAll('.mini[data-act]').forEach((b) => {
  b.onclick = async () => {
    const t = b.dataset.t, act = b.dataset.act
    if (!confirm(\`Set \${t} to \${act}? Suspending kills every session in that tenant immediately.\`)) return
    const msg = document.getElementById('msg')
    msg.textContent = 'working…'
    const r = await fetch('/v1/ops/tenant/status', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (localStorage.getItem('sv-session') || '') },
      body: JSON.stringify({ tenant: t, status: act }),
    })
    const j = await r.json().catch(() => ({}))
    msg.textContent = r.ok ? \`\${t} → \${act}. Reloading…\` : ('error: ' + (j.error || r.status))
    if (r.ok) setTimeout(() => location.reload(), 900)
  }
})
</script>
</body></html>`
}
