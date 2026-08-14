#!/usr/bin/env node
// session-viz fleet backend — the reference-table side of the one-way valve.
//
// Design rules this file enforces (they are architecture, not policy):
//   1. There is NO person column anywhere. Findings are keyed on artifacts —
//      task class, cli version band, terminal state. The join that would
//      produce a per-person view cannot be written because the data to write
//      it does not exist here.
//   2. The contribution schema is CLOSED: fixed fields, enums and bounded
//      integers only. No free-text string survives validation, so a payload
//      carrying a prompt, a path or a name is unrepresentable.
//   3. The reference table is k-gated: cells with fewer than K findings are
//      suppressed and the suppression is counted, never silent.
//   4. Down-flow (GET /v1/reference/latest) takes no request body and sets no
//      cookie — there is nothing in the request to key a profile on.
//
// Storage: Postgres when DATABASE_URL is set (Railway), in-memory otherwise
// (local smoke tests). At prototype scale every aggregate is computed in JS
// from a full read, so both stores share one code path.

import http from 'node:http'
import crypto from 'node:crypto'
import {
  initCollab, sseHandler, liveStats, registerVault, listVaults, resolveLink, danglingLinks,
  createTask, transitionTask, listTasks, recentEvents, mcpDispatch, emit,
} from './collab.mjs'
import {
  initAuth, authMem, otpStart, otpVerify, resolveSession, revokeSession,
  passkeyChallenge, passkeyRegister, passkeyLogin, tenantForEmail,
  loadAccount, listMembers, inviteMember, setRole, setStatus,
} from './auth.mjs'
import {
  initOps, isOperator, operatorEmails, opsOverview, opsHtml,
  setTenantStatus, deleteTenant, readAudit, audit,
} from './ops.mjs'
import { initMail, sendMail, mailHealth, mailLog, mailConfig } from './mail.mjs'

const PORT = Number(process.env.PORT || 8787)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''
const CONTRIB_TOKEN = process.env.CONTRIB_TOKEN || ''
const COLLAB_TOKEN = process.env.COLLAB_TOKEN || ''
const K = Number(process.env.K_GATE || 5)
const MAX_BODY = 1 << 20 // 1 MiB
const SCHEMA_VERSION = 'contrib_v1'

// ---------------------------------------------------------------- signing

// Ed25519 via node:crypto — no dependency. A persistent key comes from the
// environment; otherwise an ephemeral pair is generated and /healthz says so,
// because a reference file signed with a key that dies on restart is only
// tamper-evidence, not identity.
let privateKey, publicPem, ephemeralKey
if (process.env.ED25519_PRIVATE_PEM) {
  privateKey = crypto.createPrivateKey(process.env.ED25519_PRIVATE_PEM)
  ephemeralKey = false
} else {
  const pair = crypto.generateKeyPairSync('ed25519')
  privateKey = pair.privateKey
  ephemeralKey = true
}
publicPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' })

const sign = (payloadString) => crypto.sign(null, Buffer.from(payloadString), privateKey).toString('base64')

// ---------------------------------------------------------------- schema

// The closed contribution type. additionalProperties:false is implemented
// literally: any unknown key rejects the finding.
const FIELDS = ['kind', 'task_class', 'cli_band', 'iso_week', 'terminal_state', 'delivery_state', 'error_class', 'cost_bucket', 'tool_bucket']
const ENUMS = {
  kind: ['human_session', 'scheduled', 'subagent'],
  terminal_state: ['completed_structured', 'completed_prose', 'truncated', 'abandoned_mid_tool', 'infra_halt', 'zombie', 'unknown'],
  // `wrote_ok`, not DELIVERED: without an mtime probe on the target filesystem
  // the server cannot witness delivery, and the name must not overclaim.
  delivery_state: ['wrote_ok', 'denied', 'no_intent', 'unverified'],
  error_class: ['none', 'permission', 'auth', 'tool_error', 'other'],
}

function validateFinding(f) {
  if (typeof f !== 'object' || f === null || Array.isArray(f)) return 'not an object'
  for (const k of Object.keys(f)) if (!FIELDS.includes(k)) return `unknown field: ${k}`
  for (const k of FIELDS) if (!(k in f)) return `missing field: ${k}`
  for (const k of Object.keys(ENUMS)) if (!ENUMS[k].includes(f[k])) return `invalid ${k}`
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(f.task_class)) return 'invalid task_class'
  if (!/^\d+\.\d+\.\d*x$/.test(f.cli_band)) return 'invalid cli_band'
  if (!/^\d{4}-W\d{2}$/.test(f.iso_week)) return 'invalid iso_week'
  if (!Number.isInteger(f.cost_bucket) || f.cost_bucket < 0 || f.cost_bucket > 40) return 'invalid cost_bucket'
  if (!Number.isInteger(f.tool_bucket) || f.tool_bucket < 0 || f.tool_bucket > 14) return 'invalid tool_bucket'
  return null
}

// ---------------------------------------------------------------- storage

let pool = null
const mem = []

async function initStore() {
  if (!process.env.DATABASE_URL) return 'memory'
  const { default: pg } = await import('pg')
  const url = process.env.DATABASE_URL
  pool = new pg.Pool({
    connectionString: url,
    ssl: /railway\.internal|localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
  })
  // No person column. That is the point — see header.
  await pool.query(`create table if not exists finding(
    id bigserial primary key,
    schema_version text not null,
    kind text not null,
    task_class text not null,
    cli_band text not null,
    iso_week text not null,
    terminal_state text not null,
    delivery_state text not null,
    error_class text not null,
    cost_bucket int not null,
    tool_bucket int not null
  )`)
  return 'postgres'
}

async function insertFindings(rows) {
  if (!pool) {
    for (const r of rows) mem.push(r)
    return
  }
  const cols = ['schema_version', 'tenant', ...FIELDS]
  const values = []
  const params = []
  rows.forEach((r, i) => {
    const base = i * cols.length
    values.push(`(${cols.map((_, j) => `$${base + j + 1}`).join(',')})`)
    params.push(SCHEMA_VERSION, r.__tenant || null, ...FIELDS.map((k) => r[k]))
  })
  await pool.query(`insert into finding(${cols.join(',')}) values ${values.join(',')}`, params)
}

async function allFindings() {
  if (!pool) return mem
  const { rows } = await pool.query(`select ${FIELDS.join(',')} from finding`)
  return rows
}

// ---------------------------------------------------------------- aggregate

const count = (rows, f) => rows.filter(f).length
const uniq = (rows, k) => [...new Set(rows.map((r) => r[k]))].sort()

function groupBy(rows, keys) {
  const m = new Map()
  for (const r of rows) {
    const key = keys.map((k) => r[k]).join('|')
    if (!m.has(key)) m.set(key, { ...Object.fromEntries(keys.map((k) => [k, r[k]])), n: 0, rows: [] })
    const g = m.get(key)
    g.n++
    g.rows.push(r)
  }
  return [...m.values()].sort((a, b) => b.n - a.n)
}

function buildReference(rows) {
  const tenants = new Set(rows.map((r) => r.tenant).filter(Boolean))
  // Below MIN_TENANTS contributing tenants overall there is no crowd to hide
  // in, so the tenant condition is not yet applied — it is reported as pending
  // rather than silently satisfied.
  const enforceTenants = tenants.size >= MIN_TENANTS
  const gate = { k: K, minTenants: MIN_TENANTS, tenantsContributing: tenants.size,
    tenantGateActive: enforceTenants, suppressed: 0, suppressedForTenants: 0 }
  const cell = (groups, shape) =>
    groups
      .filter((g) => {
        if (g.n < K) { gate.suppressed++; return false }
        if (enforceTenants) {
          const t = new Set(g.rows.map((r) => r.tenant).filter(Boolean))
          if (t.size < MIN_TENANTS) { gate.suppressedForTenants++; return false }
        }
        return true
      })
      .map((g) => shape(g))

  const payload = {
    schema_version: SCHEMA_VERSION,
    generated_at: new Date().toISOString().slice(0, 10),
    findings: rows.length,
    kinds: groupBy(rows, ['kind']).map((g) => ({ kind: g.kind, n: g.n })),
    terminal_by_kind: cell(groupBy(rows, ['kind', 'terminal_state']), (g) => ({
      kind: g.kind, terminal_state: g.terminal_state, n: g.n,
    })),
    delivery_by_task: cell(groupBy(rows.filter((r) => r.kind !== 'human_session'), ['task_class', 'delivery_state']), (g) => ({
      task_class: g.task_class, delivery_state: g.delivery_state, n: g.n,
    })),
    error_by_band: cell(groupBy(rows, ['cli_band', 'error_class']), (g) => ({
      cli_band: g.cli_band, error_class: g.error_class, n: g.n,
    })),
    weeks: groupBy(rows, ['iso_week']).map((g) => ({
      iso_week: g.iso_week, n: g.n,
      denied: count(g.rows, (r) => r.delivery_state === 'denied'),
    })).sort((a, b) => a.iso_week.localeCompare(b.iso_week)),
    gate,
  }
  return payload
}

// ---------------------------------------------------------------- admin html

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const approxTokens = (b) => (2 ** b >= 1e6 ? (2 ** b / 1e6).toFixed(1) + 'M' : 2 ** b >= 1e3 ? Math.round(2 ** b / 1e3) + 'k' : String(2 ** b))
const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '—')

function adminHtml(rows, store) {
  const kinds = groupBy(rows, ['kind'])
  const sched = rows.filter((r) => r.kind !== 'human_session')
  const denied = count(sched, (r) => r.delivery_state === 'denied')
  const zombie = count(rows, (r) => r.terminal_state === 'zombie')
  const weeks = groupBy(rows, ['iso_week']).sort((a, b) => a.iso_week.localeCompare(b.iso_week))
  const tasks = groupBy(rows, ['task_class'])
  const gate = { suppressed: 0 }

  const kindRow = (g) => {
    const terminal = groupBy(g.rows, ['terminal_state'])
    return `<tr><td class="name">${esc(g.kind)}</td><td class="r num">${g.n}</td>
      <td>${terminal.map((t) => `<span class="chip">${esc(t.terminal_state)} <b>${t.n}</b></span>`).join('')}</td></tr>`
  }

  const taskRow = (g) => {
    if (g.n < K && g.task_class !== 'human') { gate.suppressed++; return '' }
    const d = count(g.rows, (r) => r.delivery_state === 'denied')
    const ok = count(g.rows, (r) => r.delivery_state === 'wrote_ok')
    const costs = g.rows.map((r) => r.cost_bucket).sort((a, b) => a - b)
    const med = costs[Math.floor(costs.length / 2)] ?? 0
    const okRate = ok + d > 0 ? pct(ok, ok + d) : `<span class="dim">no write intent witnessed (${g.n} runs)</span>`
    return `<tr${d > g.n / 2 ? ' class="bad"' : ''}>
      <td class="name num">${esc(g.task_class)}</td><td class="r num">${g.n}</td>
      <td class="r num">${d || '–'}</td><td class="r num">${okRate}</td>
      <td class="r num">~${approxTokens(med)}</td></tr>`
  }

  const weekRow = (g) => `<tr><td class="num">${esc(g.iso_week)}</td><td class="r num">${g.n}</td>
    <td class="r num">${count(g.rows, (r) => r.delivery_state === 'denied') || '–'}</td>
    <td class="r num">${count(g.rows, (r) => r.terminal_state === 'zombie') || '–'}</td></tr>`

  const taskRows = tasks.map(taskRow).join('')

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>fleet admin — session-viz</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1c1b19;--muted:#6b6862;--line:#e6e2db;--accent:#c2521a;
--accent-soft:#fdf0e8;--ok:#2f6b46;--warn:#9a6a12;--bad:#b3261e;--bar:#d9d4cb;
--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#16151a;--panel:#1e1d23;--ink:#ece9e4;--muted:#9b968d;
--line:#302e37;--accent:#ff8a4c;--accent-soft:#2a1d16;--ok:#6fbf8e;--warn:#e0b055;--bad:#ff6b5e;--bar:#3a3742}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Inter,sans-serif;padding:28px 20px 60px}
.wrap{max-width:1000px;margin:0 auto}
h1{font-size:20px;margin:0 0 3px}
h2{font-size:11.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:28px 0 10px;font-weight:700}
.sub{color:var(--muted);font-size:12.5px;font-family:var(--mono)}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(118px,1fr));background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;margin-top:14px}
.stat{padding:12px 15px;border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.stat .n{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums}
.stat .l{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-top:1px}
.stat.hot .n{color:var(--bad)}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);font-weight:600;padding:0 10px 7px;border-bottom:1px solid var(--line)}
th.r,td.r{text-align:right}
td{padding:9px 10px;border-bottom:1px solid var(--line)}
tbody tr:last-child td{border-bottom:0}
tr.bad td{background:color-mix(in srgb,var(--bad) 7%,transparent)}
.num{font-variant-numeric:tabular-nums;font-family:var(--mono);font-size:12.5px}
.name{font-weight:600}
.dim{color:var(--muted)}
.chip{font-family:var(--mono);font-size:11px;background:var(--bg);border:1px solid var(--line);border-radius:5px;padding:2px 7px;color:var(--muted);display:inline-block;margin:0 4px 4px 0}
.chip b{color:var(--ink)}
.note{border-left:3px solid var(--accent);padding:2px 0 2px 14px;margin:14px 0;font-size:13.5px;color:var(--muted)}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:11.5px;font-family:var(--mono)}
</style></head><body><div class="wrap">
<h1>Fleet admin</h1>
<div class="sub">store: ${esc(store)} · schema ${SCHEMA_VERSION} · k-gate ${K}${ephemeralKey ? ' · signing key: ephemeral' : ''}</div>

<div class="stats">
  <div class="stat"><div class="n">${rows.length}</div><div class="l">findings</div></div>
  ${kinds.map((g) => `<div class="stat"><div class="n">${g.n}</div><div class="l">${esc(g.kind.replace('_', ' '))}</div></div>`).join('')}
  <div class="stat${denied > sched.length / 2 ? ' hot' : ''}"><div class="n">${pct(denied, sched.length)}</div><div class="l">denied (sched)</div></div>
  <div class="stat"><div class="n">${pct(zombie, rows.length)}</div><div class="l">zombie</div></div>
  <div class="stat"><div class="n">${uniq(rows, 'iso_week').length}</div><div class="l">weeks</div></div>
</div>

<h2>Runs by kind × terminal state</h2>
<div class="card"><table>
<thead><tr><th>Kind</th><th class="r">n</th><th>Terminal states</th></tr></thead>
<tbody>${kinds.map(kindRow).join('')}</tbody></table></div>

<h2>Task classes <span class="dim" style="text-transform:none;letter-spacing:0">— wrote-ok is not delivery; no filesystem probe ran</span></h2>
<div class="card"><table>
<thead><tr><th>Task class</th><th class="r">Runs</th><th class="r">Denied</th><th class="r">Wrote ok</th><th class="r">Median output</th></tr></thead>
<tbody>${taskRows || '<tr><td colspan="5" class="dim">no findings yet — POST /v1/contrib</td></tr>'}</tbody></table>
${gate.suppressed ? `<p class="dim" style="font-size:12px;margin:10px 0 0">${gate.suppressed} task class(es) suppressed under the k-gate (n &lt; ${K}).</p>` : ''}</div>

<h2>Weekly</h2>
<div class="card"><table>
<thead><tr><th>ISO week</th><th class="r">Findings</th><th class="r">Denied</th><th class="r">Zombie</th></tr></thead>
<tbody>${weeks.map(weekRow).join('') || '<tr><td colspan="4" class="dim">—</td></tr>'}</tbody></table></div>

<div class="note">No person column exists in this store. The join that would produce a per-person view is absent by design — it cannot be added by a query, a policy change, or a dashboard request. Subjects here are task classes, version bands and terminal states: things a commit can fix.</div>

<footer>session-viz fleet backend v0 · POST /v1/contrib (bearer) · GET /v1/reference/latest (public, signed) · GET /healthz</footer>
</div></body></html>`
}

// ---------------------------------------------------------------- http

const tokenOk = (given, expected) => {
  if (!expected || !given) return false
  const a = Buffer.from(String(given))
  const b = Buffer.from(String(expected))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '')

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const json = (res, code, obj) => {
  const body = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

const storeType = await initStore()
// Plane B shares the connection but not the schema; initCollab asserts at boot
// that nothing can join it to the person-blind `finding` table.
await initCollab(pool)
await initAuth(pool)
await initOps(pool)
await initMail(pool)
const AMEM = authMem()
// Distinct-tenant floor. Once several customers contribute, a cell drawn from
// one tenant is that tenant's number wearing a crowd's clothes.
const MIN_TENANTS = Number(process.env.MIN_TENANTS || 3)
const RP_ID = process.env.RP_ID || ''
const ORIGIN = process.env.ORIGIN || ''
// In production this hands off to an email provider. Unset, the code is logged
// so a self-hosted deployment is usable on day one — and the log line says so.
const deliverOtp = async ({ email, code, expiresInMinutes }) => {
  const r = await sendMail(pool, {
    template: 'auth.otp', to: email, critical: true,
    vars: { code, minutes: expiresInMinutes },
  })
  if (r.dryRun) console.log(`[otp] ${email} -> ${code} (valid ${expiresInMinutes}m) — RESEND_API_KEY unset`)
}

// The landing page is on the apex and the API on a subdomain, so every browser
// call is cross-origin. Allowed origins are an explicit list — a reflected
// Origin with credentials is how these mistakes usually happen.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://session-viz.com,https://www.session-viz.com,http://localhost:8080').split(',').map((s) => s.trim())

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const reqOrigin = req.headers.origin
  if (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) {
    res.setHeader('access-control-allow-origin', reqOrigin)
    res.setHeader('vary', 'Origin')
    res.setHeader('access-control-allow-headers', 'content-type,authorization,x-actor,x-tenant')
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS')
    res.setHeader('access-control-max-age', '600')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      const rows = await allFindings()
      return json(res, 200, {
        ok: true, store: storeType, findings: rows.length, ephemeral_key: ephemeralKey,
        schema: SCHEMA_VERSION, live: liveStats(),
        planes: { a: 'finding (person-blind)', b: 'collab_* (identity-bearing, cannot join a)' },
        auth: { methods: ['email-otp', 'passkey'], multiTenant: true, minTenants: MIN_TENANTS },
        mail: await mailHealth(pool),
        levels: { l0: 'operator', l1: 'tenant admin', l2: 'member' },
      })
    }

    // ---------------- auth: email OTP + passkey ----------------------------
    if (url.pathname.startsWith('/v1/auth/')) {
      const body = req.method === 'POST' ? await (async () => { try { return JSON.parse(await readBody(req)) } catch { return {} } })() : {}
      const rp = RP_ID || req.headers.host?.split(':')[0] || ''
      const orig = ORIGIN || (req.headers.origin || '')
      try {
        if (url.pathname === '/v1/auth/otp/start')
          return json(res, 200, await otpStart(pool, AMEM, { email: body.email, deliver: deliverOtp }))
        if (url.pathname === '/v1/auth/otp/verify')
          return json(res, 200, await otpVerify(pool, AMEM, { email: body.email, code: body.code }))
        if (url.pathname === '/v1/auth/passkey/challenge')
          return json(res, 200, { ...(await passkeyChallenge(pool, AMEM, { email: body.email, kind: body.kind === 'register' ? 'register' : 'login' })), rpId: rp })
        if (url.pathname === '/v1/auth/passkey/register')
          return json(res, 200, await passkeyRegister(pool, AMEM, { ...body, origin: orig, rpId: rp }))
        if (url.pathname === '/v1/auth/passkey/login')
          return json(res, 200, await passkeyLogin(pool, AMEM, { ...body, origin: orig, rpId: rp }))
        if (url.pathname === '/v1/auth/me') {
          const sess = await resolveSession(pool, AMEM, bearer(req))
          return sess ? json(res, 200, sess) : json(res, 401, { error: 'not signed in' })
        }
        if (url.pathname === '/v1/auth/logout')
          return json(res, 200, await revokeSession(pool, AMEM, bearer(req)))
      } catch (e) { return json(res, 400, { error: e.message }) }
      return json(res, 404, { error: 'not found' })
    }

    // ---------------- L0 operator console ----------------------------------
    // Operator identity comes from the signed-in session, never from a header
    // or a query parameter — a bearer token that happens to be valid is not an
    // operator claim.
    if (url.pathname === '/ops' || url.pathname.startsWith('/v1/ops')) {
      const sess = await resolveSession(pool, AMEM, bearer(req) || url.searchParams.get('token'))
      const op = sess && isOperator(sess.email)
      if (url.pathname === '/ops' && !op) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(`<!doctype html><meta charset="utf-8"><title>ops</title>
<body style="font:15px/1.6 ui-sans-serif;background:#16151a;color:#ece9e4;padding:60px 24px;max-width:60ch;margin:0 auto">
<h1 style="font-size:19px">Operator console</h1>
<p style="color:#9b968d">Sign in at <a href="https://session-viz.com" style="color:#ff8a4c">session-viz.com</a>
with an operator account, then return here. The console reads your session token from this browser.</p>
<p style="color:#9b968d;font:12px/1.6 ui-monospace">operators: ${esc(operatorEmails().join(', '))}</p>
<script>const t=localStorage.getItem('sv-session');if(t)location.replace('/ops?token='+encodeURIComponent(t))</script>
</body>`)
      }
      if (!op) return json(res, 403, { error: 'operator access required' })

      if (url.pathname === '/ops') {
        const rows = await allFindings()
        const ref = buildReference(rows)
        const o = await opsOverview(pool, { findings: rows.length, gate: ref.gate, mail: await mailHealth(pool) })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex' })
        return res.end(opsHtml(o, { audit: await readAudit(pool), me: sess.email }))
      }

      const body = req.method === 'POST' ? await (async () => { try { return JSON.parse(await readBody(req)) } catch { return {} } })() : {}
      try {
        if (req.method === 'GET' && url.pathname === '/v1/ops/overview') {
          const rows = await allFindings()
          return json(res, 200, await opsOverview(pool, { findings: rows.length, gate: buildReference(rows).gate, mail: await mailHealth(pool) }))
        }
        if (req.method === 'GET' && url.pathname === '/v1/ops/audit')
          return json(res, 200, await readAudit(pool))
        if (req.method === 'GET' && url.pathname === '/v1/ops/mail')
          return json(res, 200, { health: await mailHealth(pool), recent: await mailLog(pool, 100) })
        if (req.method === 'POST' && url.pathname === '/v1/ops/mail/test') {
          const r = await sendMail(pool, { template: 'auth.new-device', to: sess.email,
            vars: { method: 'operator test', when: new Date().toISOString().slice(0, 16).replace('T', ' ') } })
          await audit(pool, { actor: sess.email, action: 'mail.test', subject: sess.email, detail: r })
          return json(res, 200, r)
        }
        if (req.method === 'POST' && url.pathname === '/v1/ops/tenant/status')
          return json(res, 200, await setTenantStatus(pool, { actor: sess.email, tenant: body.tenant, status: body.status, note: body.note }))
        if (req.method === 'POST' && url.pathname === '/v1/ops/tenant/delete') {
          // Two-key rule: the caller must name the tenant twice, so a mistyped
          // id cannot delete the wrong customer.
          if (body.confirm !== body.tenant) return json(res, 400, { error: 'confirm must repeat the tenant id' })
          return json(res, 200, await deleteTenant(pool, { actor: sess.email, tenant: body.tenant, alsoFindings: !!body.alsoFindings }))
        }
      } catch (e) {
        await audit(pool, { actor: sess.email, action: 'error', subject: url.pathname, detail: { message: e.message } })
        return json(res, 400, { error: e.message })
      }
      return json(res, 404, { error: 'not found' })
    }

    // ---------------- L1 team administration -------------------------------
    // Every route here loads the caller's account server-side and checks the
    // role there. The UI decides what to show; it never decides what is allowed.
    if (url.pathname.startsWith('/v1/team')) {
      const sess = await resolveSession(pool, AMEM, bearer(req))
      if (!sess) return json(res, 401, { error: 'not signed in' })
      const me = await loadAccount(pool, AMEM, sess.account)
      const body = req.method === 'POST' ? await (async () => { try { return JSON.parse(await readBody(req)) } catch { return {} } })() : {}
      try {
        if (req.method === 'GET' && url.pathname === '/v1/team')
          return json(res, 200, { tenant: sess.tenant, you: { id: me.id, email: me.email, role: me.role },
            members: await listMembers(pool, AMEM, { tenant: sess.tenant }) })
        if (req.method === 'POST' && url.pathname === '/v1/team/invite') {
          const out = await inviteMember(pool, AMEM, { admin: me, email: body.email, role: body.role })
          await sendMail(pool, { template: 'team.invited', to: out.invited, tenant: out.tenant,
            vars: { inviter: me.email, tenant: out.tenant, role: out.role } })
          return json(res, 200, out)
        }
        if (req.method === 'POST' && url.pathname === '/v1/team/role') {
          const out = await setRole(pool, AMEM, { admin: me, accountId: body.accountId, role: body.role })
          const t = await loadAccount(pool, AMEM, body.accountId)
          if (t) await sendMail(pool, { template: 'team.role-changed', to: t.email, tenant: sess.tenant,
            vars: { role: out.role, tenant: sess.tenant, by: me.email } })
          return json(res, 200, out)
        }
        if (req.method === 'POST' && url.pathname === '/v1/team/status') {
          const t = await loadAccount(pool, AMEM, body.accountId)
          const out = await setStatus(pool, AMEM, { admin: me, accountId: body.accountId, status: body.status })
          if (t && out.status === 'suspended') await sendMail(pool, { template: 'team.suspended', to: t.email,
            tenant: sess.tenant, vars: { tenant: sess.tenant, by: me.email } })
          return json(res, 200, out)
        }
      } catch (e) { return json(res, 403, { error: e.message }) }
      return json(res, 404, { error: 'not found' })
    }

    // ---------------- Plane B: live sync, vaults, handoff, MCP -------------
    // One token for the collaboration plane. Deliberately NOT the contrib
    // token: a machine that ships anonymous telemetry should not thereby be
    // able to read who is working on what.
    // Either a signed-in session (preferred — carries a tenant and an identity)
    // or the shared COLLAB_TOKEN for machine clients on a single-tenant install.
    const sess = await resolveSession(pool, AMEM, bearer(req) || url.searchParams.get('token'))
    const collabOk = () => !!sess || tokenOk(bearer(req) || url.searchParams.get('token'), COLLAB_TOKEN)
    const whoami = () => sess?.email || String(req.headers['x-actor'] || url.searchParams.get('actor') || '').slice(0, 64)
    const tenantOf = () => sess?.tenant || String(req.headers['x-tenant'] || 't_default')

    if (url.pathname === '/v1/live') {
      if (!collabOk()) return json(res, 401, { error: 'bad collab token' })
      return sseHandler(req, res, Number(url.searchParams.get('since') || 0))
    }

    if (url.pathname === '/v1/mcp') {
      if (req.method === 'GET')
        return json(res, 200, { transport: 'http-jsonrpc', stateless: true, auth: 'Bearer COLLAB_TOKEN', actor_header: 'X-Actor' })
      if (req.method !== 'POST') return json(res, 405, { error: 'POST JSON-RPC' })
      if (!collabOk()) return json(res, 401, { error: 'bad collab token' })
      const actor = whoami()
      if (!actor) return json(res, 400, { error: 'X-Actor header required' })
      let body
      try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'invalid json' }) }
      const batch = Array.isArray(body) ? body : [body]
      const out = []
      for (const one of batch) out.push(await mcpDispatch(pool, { body: one, actor }))
      return json(res, 200, Array.isArray(body) ? out : out[0])
    }

    if (url.pathname.startsWith('/v1/vaults') || url.pathname.startsWith('/v1/tasks') || url.pathname === '/v1/events') {
      if (!collabOk()) return json(res, 401, { error: 'bad collab token' })
      const actor = whoami()
      const readBodyJson = async () => { try { return JSON.parse(await readBody(req)) } catch { return {} } }

      if (req.method === 'GET' && url.pathname === '/v1/vaults')
        return json(res, 200, await listVaults(pool, { scope: url.searchParams.get('scope') || undefined }))
      if (req.method === 'POST' && url.pathname === '/v1/vaults') {
        if (!actor) return json(res, 400, { error: 'X-Actor required' })
        return json(res, 200, await registerVault(pool, { actor, ...(await readBodyJson()) }))
      }
      if (req.method === 'GET' && url.pathname === '/v1/vaults/resolve')
        return json(res, 200, await resolveLink(pool, { name: url.searchParams.get('name'), fromVault: url.searchParams.get('from') }))
      if (req.method === 'GET' && url.pathname === '/v1/vaults/dangling')
        return json(res, 200, await danglingLinks(pool, { vaultId: url.searchParams.get('vault') }))

      if (req.method === 'GET' && url.pathname === '/v1/tasks')
        return json(res, 200, await listTasks(pool, {
          actor: url.searchParams.get('mine') ? actor : undefined,
          state: url.searchParams.get('state') || undefined,
          scope: url.searchParams.get('scope') || undefined,
        }))
      if (req.method === 'POST' && url.pathname === '/v1/tasks') {
        if (!actor) return json(res, 400, { error: 'X-Actor required' })
        return json(res, 200, await createTask(pool, { actor, ...(await readBodyJson()) }))
      }
      if (req.method === 'POST' && /^\/v1\/tasks\/[\w]+\/(offered|accepted|done|draft)$/.test(url.pathname)) {
        if (!actor) return json(res, 400, { error: 'X-Actor required' })
        const [, , , id, to] = url.pathname.split('/')
        try {
          const note = await readBodyJson()
          const out = await transitionTask(pool, { actor, id, to, note })
          // Only the title travels — the brief stays in the app by design.
          if (to === 'offered' && out.assigned_to && out.assigned_to.includes('@')) {
            await sendMail(pool, { template: 'task.offered', to: out.assigned_to, tenant: tenantOf(),
              vars: { from: actor, title: out.title, tenant: tenantOf() } })
          }
          return json(res, 200, out)
        } catch (e) { return json(res, 409, { error: e.message }) }
      }
      if (req.method === 'GET' && url.pathname === '/v1/events')
        return json(res, 200, await recentEvents(pool, { since: Number(url.searchParams.get('since') || 0) }))
      return json(res, 404, { error: 'not found' })
    }

    if (req.method === 'GET' && url.pathname === '/v1/pubkey') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end(publicPem)
    }

    if (req.method === 'POST' && url.pathname === '/v1/contrib') {
      if (!tokenOk(bearer(req), CONTRIB_TOKEN)) return json(res, 401, { error: 'bad contrib token' })
      let body
      try { body = JSON.parse(await readBody(req)) } catch { return json(res, 400, { error: 'invalid json' }) }
      const list = Array.isArray(body?.findings) ? body.findings : null
      if (!list) return json(res, 400, { error: 'expected {findings:[...]}' })
      if (list.length > 5000) return json(res, 400, { error: 'max 5000 findings per request' })
      const rejected = []
      const accepted = []
      list.forEach((f, i) => {
        const err = validateFinding(f)
        if (err) rejected.push({ i, err })
        else accepted.push(f)
      })
      if (accepted.length) await insertFindings(accepted)
      return json(res, rejected.length && !accepted.length ? 400 : 200, { accepted: accepted.length, rejected })
    }

    if (req.method === 'GET' && url.pathname === '/v1/reference/latest') {
      const payload = buildReference(await allFindings())
      const payloadString = JSON.stringify(payload)
      const body = JSON.stringify({ payload, signature_b64: sign(payloadString), pubkey_pem: publicPem, ephemeral_key: ephemeralKey })
      res.writeHead(200, {
        'content-type': 'application/json',
        'access-control-allow-origin': '*',
        'cache-control': 'public, max-age=300',
      })
      return res.end(body)
    }

    if (req.method === 'GET' && url.pathname === '/admin') {
      const given = url.searchParams.get('token') || bearer(req)
      if (!tokenOk(given, ADMIN_TOKEN)) {
        res.writeHead(401, { 'content-type': 'text/plain' })
        return res.end('401 — pass ?token= or a bearer token')
      }
      const rows = await allFindings()
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(adminHtml(rows, storeType))
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      return res.end([
        'session-viz backend v0',
        '',
        'PLANE A — fleet telemetry (person-blind, closed schema, k-gated)',
        '  GET  /healthz',
        '  GET  /v1/reference/latest    public, Ed25519-signed',
        '  GET  /v1/pubkey',
        '  POST /v1/contrib             Bearer CONTRIB_TOKEN',
        '  GET  /admin?token=...',
        '',
        'PLANE B — collaboration (identity-bearing; cannot join plane A)',
        '  GET  /v1/live                SSE stream        Bearer COLLAB_TOKEN',
        '  POST /v1/mcp                 stateless MCP     Bearer + X-Actor',
        '  GET  /v1/vaults              ?scope=',
        '  POST /v1/vaults              register/refresh a vault index',
        '  GET  /v1/vaults/resolve      ?name=[[Link]]&from=vault_id',
        '  GET  /v1/vaults/dangling     ?vault=vault_id',
        '  GET  /v1/tasks               ?mine=1&state=&scope=',
        '  POST /v1/tasks               create',
        '  POST /v1/tasks/:id/offered|accepted|done',
        '  GET  /v1/events              ?since=seq',
        '',
        'AUTH — passwordless, multi-tenant (mandantenfähig)',
        '  POST /v1/auth/otp/start           {email}',
        '  POST /v1/auth/otp/verify          {email, code} -> session token',
        '  POST /v1/auth/passkey/challenge   {email, kind:register|login}',
        '  POST /v1/auth/passkey/register    {challengeId, email, credential}',
        '  POST /v1/auth/passkey/login       {challengeId, credential}',
        '  GET  /v1/auth/me                  Bearer session',
        '  POST /v1/auth/logout',
        '',
        'TEAM — L1 tenant administration (admin role required)',
        '  GET  /v1/team                     members of your tenant',
        '  POST /v1/team/invite              {email, role}',
        '  POST /v1/team/role                {accountId, role}',
        '  POST /v1/team/status              {accountId, status}',
        '',
        'OPS — L0 operator, metadata only, every action audited',
        '  GET  /ops                         console (operator session)',
        '  GET  /v1/ops/overview',
        '  GET  /v1/ops/audit',
        '  POST /v1/ops/tenant/status        {tenant, status, note}',
        '  POST /v1/ops/tenant/delete        {tenant, confirm, alsoFindings}',
        '  GET  /v1/ops/mail                 delivery health + last 100 sends',
        '  POST /v1/ops/mail/test            send yourself a test',
        '',
      ].join('\n'))
    }

    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String(e.message || e) })
  }
})

server.listen(PORT, () => {
  console.log(`fleet-backend listening on :${PORT} store=${storeType} ephemeral_key=${ephemeralKey}`)
  if (!ADMIN_TOKEN) console.log('WARNING: ADMIN_TOKEN unset — /admin will always 401')
  if (!CONTRIB_TOKEN) console.log('WARNING: CONTRIB_TOKEN unset — /v1/contrib will always 401')
  if (!COLLAB_TOKEN) console.log('WARNING: COLLAB_TOKEN unset — plane B will always 401')
})
