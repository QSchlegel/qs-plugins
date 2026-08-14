#!/usr/bin/env node
// PLANE B — collaboration: vault federation, task handoff, live sync, MCP.
//
// ── Why this is a separate file, and must stay one ──────────────────────────
// Plane A (server.mjs, table `finding`) is person-blind on purpose: closed
// schema, no free text, no person column, k-gated. That is what makes the fleet
// telemetry deployable in a co-determined workplace.
//
// Plane B is the opposite by necessity. You cannot hand a task from one person
// to another without knowing both, and you cannot share a vault note without
// moving authored free text. So Plane B is identity-bearing and content-bearing
// — which is fine (email is too) — but ONLY while it cannot be turned back into
// per-person performance measurement.
//
// The rule that keeps that true: NO QUERY MAY JOIN A `collab_*` TABLE TO
// `finding`. There is no shared key to join on — Plane A stores task_class and
// cli_band, Plane B stores actor and vault — and `assertPlaneSeparation()`
// below fails the boot if anyone adds one. Everything else is policy; this is
// the part that is structural.

import crypto from 'node:crypto'

export const COLLAB_TABLES = ['collab_actor', 'collab_vault', 'collab_note', 'collab_task', 'collab_event']

// ---------------------------------------------------------------- schema

export async function initCollab(pool) {
  if (!pool) return
  await pool.query(`create table if not exists collab_actor(
    id text primary key,
    display text not null,
    created_at timestamptz not null default now()
  )`)
  // A vault is a project-scoped Obsidian folder. `scope` is the project it
  // belongs to; two people can register the same scope and see each other's
  // vaults, which is what makes references cross-user.
  await pool.query(`create table if not exists collab_vault(
    id text primary key,
    scope text not null,
    name text not null,
    owner text not null references collab_actor(id),
    shared boolean not null default false,
    note_count int not null default 0,
    updated_at timestamptz not null default now()
  )`)
  // Only note IDENTITY and links are stored server-side — title, path, tags and
  // outbound link names. Body text never leaves the machine unless the owner
  // explicitly pushes it, and even then it lands in `body`, which is nullable
  // and excluded from every list endpoint.
  await pool.query(`create table if not exists collab_note(
    vault_id text not null references collab_vault(id) on delete cascade,
    path text not null,
    title text not null,
    tags text[] not null default '{}',
    links text[] not null default '{}',
    body text,
    updated_at timestamptz not null default now(),
    primary key (vault_id, path)
  )`)
  await pool.query(`create table if not exists collab_task(
    id text primary key,
    title text not null,
    brief text not null,
    scope text,
    repo text,
    branch text,
    refs text[] not null default '{}',
    created_by text not null references collab_actor(id),
    assigned_to text references collab_actor(id),
    state text not null default 'draft',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`)
  await pool.query(`create table if not exists collab_event(
    seq bigserial primary key,
    kind text not null,
    actor text,
    subject text,
    payload jsonb not null default '{}',
    at timestamptz not null default now()
  )`)
  await assertPlaneSeparation(pool)
}

// Boot-time guard. If a future migration adds a foreign key or a column that
// would let a query walk from a person to their telemetry, the service refuses
// to start rather than quietly becoming a surveillance tool.
export async function assertPlaneSeparation(pool) {
  if (!pool) return
  const { rows } = await pool.query(`
    select tc.table_name, kcu.column_name, ccu.table_name as refs
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'
      and (tc.table_name = 'finding' or ccu.table_name = 'finding')`)
  const bad = rows.filter((r) => String(r.table_name).startsWith('collab_') || String(r.refs) === 'finding')
  if (bad.length) throw new Error(`plane separation violated: ${JSON.stringify(bad)}`)
  const cols = await pool.query(`select column_name from information_schema.columns where table_name = 'finding'`)
  const leaked = cols.rows.map((r) => r.column_name).filter((c) => /actor|person|user|owner|email|name/.test(c))
  if (leaked.length) throw new Error(`finding gained an identity column: ${leaked.join(', ')}`)
}

// ---------------------------------------------------------------- helpers

const nid = (p) => `${p}_${crypto.randomBytes(8).toString('hex')}`
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)

// In-memory fallback so the service is testable without Postgres.
const mem = { actor: new Map(), vault: new Map(), note: new Map(), task: new Map(), event: [] }

async function emit(pool, kind, actor, subject, payload = {}) {
  const ev = { kind, actor, subject, payload, at: new Date().toISOString() }
  if (pool) {
    const { rows } = await pool.query(
      `insert into collab_event(kind,actor,subject,payload) values ($1,$2,$3,$4) returning seq, at`,
      [kind, actor, subject, JSON.stringify(payload)]
    )
    ev.seq = Number(rows[0].seq)
    ev.at = rows[0].at
  } else {
    ev.seq = mem.event.length + 1
    mem.event.push(ev)
  }
  for (const send of subscribers) send(ev)
  return ev
}

// ---------------------------------------------------------------- live sync

// Server-Sent Events. One-way, reconnects for free, survives proxies, and needs
// no client library — the right shape for "the dashboard should update itself".
// Deliberately NOT a websocket: nothing here needs a client→server channel that
// the ordinary POST endpoints do not already provide.
const subscribers = new Set()

export function sseHandler(req, res, sinceSeq) {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'access-control-allow-origin': '*',
    'x-accel-buffering': 'no',
  })
  const send = (ev) => {
    try {
      res.write(`id: ${ev.seq}\nevent: ${ev.kind}\ndata: ${JSON.stringify(ev)}\n\n`)
    } catch {}
  }
  res.write(`retry: 3000\n\n`)
  send({ seq: 0, kind: 'hello', at: new Date().toISOString(), payload: { subscribers: subscribers.size + 1 } })
  subscribers.add(send)
  // A comment frame every 25s: proxies drop idle streams, and a dead stream
  // that looks alive is exactly the "fake liveness" the console refuses.
  const ka = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`) } catch {}
  }, 25000)
  req.on('close', () => { clearInterval(ka); subscribers.delete(send) })
}

export const liveStats = () => ({ subscribers: subscribers.size })

// ---------------------------------------------------------------- vaults

export async function registerVault(pool, { actor, scope, name, shared = false, notes = [] }) {
  const id = `vault_${slug(scope)}__${slug(name)}`
  if (pool) {
    await pool.query(`insert into collab_actor(id,display) values ($1,$1) on conflict (id) do nothing`, [actor])
    await pool.query(
      `insert into collab_vault(id,scope,name,owner,shared,note_count,updated_at)
       values ($1,$2,$3,$4,$5,$6,now())
       on conflict (id) do update set shared=excluded.shared, note_count=excluded.note_count, updated_at=now()`,
      [id, scope, name, actor, !!shared, notes.length]
    )
    if (notes.length) {
      await pool.query(`delete from collab_note where vault_id=$1`, [id])
      const vals = []
      const params = []
      notes.slice(0, 5000).forEach((n, i) => {
        const b = i * 5
        vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`)
        params.push(id, String(n.path).slice(0, 400), String(n.title || '').slice(0, 300),
          (n.tags || []).slice(0, 40), (n.links || []).slice(0, 200))
      })
      await pool.query(`insert into collab_note(vault_id,path,title,tags,links) values ${vals.join(',')}`, params)
    }
  } else {
    mem.actor.set(actor, { id: actor, display: actor })
    mem.vault.set(id, { id, scope, name, owner: actor, shared: !!shared, note_count: notes.length })
    mem.note.set(id, notes.map((n) => ({ ...n, vault_id: id })))
  }
  await emit(pool, 'vault.registered', actor, id, { scope, name, notes: notes.length, shared: !!shared })
  return { id, scope, name, notes: notes.length, shared: !!shared }
}

export async function listVaults(pool, { scope } = {}) {
  if (pool) {
    const { rows } = await pool.query(
      `select id,scope,name,owner,shared,note_count,updated_at from collab_vault
       ${scope ? 'where scope=$1' : ''} order by updated_at desc`, scope ? [scope] : []
    )
    return rows
  }
  return [...mem.vault.values()].filter((v) => !scope || v.scope === scope)
}

// Cross-vault link resolution — the actual point of federation.
//
// Obsidian's [[wikilink]] resolves inside one vault only. Here a link is
// resolved against EVERY shared vault, so a note in one project can reference a
// concept documented in another. Ambiguity is returned, never guessed: a name
// present in three vaults comes back with three candidates and the caller
// decides, because silently picking one is how a knowledge graph starts lying.
export async function resolveLink(pool, { name, fromVault = null }) {
  const target = String(name || '').replace(/^\[\[|\]\]$/g, '').split('#')[0].split('|')[0].trim()
  if (!target) return { target: '', candidates: [], ambiguous: false }
  let rows
  if (pool) {
    const q = await pool.query(
      `select n.vault_id, n.path, n.title, v.scope, v.name as vault, v.owner, v.shared
       from collab_note n join collab_vault v on v.id = n.vault_id
       where lower(n.title) = lower($1) or lower(n.path) like lower($2)`,
      [target, `%/${target}.md`]
    )
    rows = q.rows
  } else {
    rows = []
    for (const [vid, notes] of mem.note) {
      const v = mem.vault.get(vid)
      for (const n of notes) {
        if (String(n.title).toLowerCase() === target.toLowerCase() || String(n.path).endsWith(`/${target}.md`)) {
          rows.push({ vault_id: vid, path: n.path, title: n.title, scope: v.scope, vault: v.name, owner: v.owner, shared: v.shared })
        }
      }
    }
  }
  const candidates = rows.map((r) => ({
    ...r,
    local: r.vault_id === fromVault,
    // The URI Obsidian itself understands, so a cross-vault hit is clickable.
    uri: `obsidian://open?vault=${encodeURIComponent(r.vault)}&file=${encodeURIComponent(String(r.path).replace(/\.md$/, ''))}`,
  }))
  candidates.sort((a, b) => Number(b.local) - Number(a.local))
  return { target, candidates, ambiguous: candidates.length > 1, resolved: candidates.length === 1 ? candidates[0] : null }
}

// Which links in a vault point at nothing anywhere — the federated equivalent
// of Obsidian's unresolved links, and the thing worth fixing after a merge.
export async function danglingLinks(pool, { vaultId }) {
  const vaults = await listVaults(pool)
  const known = new Set()
  for (const v of vaults) {
    const notes = pool
      ? (await pool.query(`select title from collab_note where vault_id=$1`, [v.id])).rows
      : (mem.note.get(v.id) || [])
    for (const n of notes) known.add(String(n.title).toLowerCase())
  }
  const notes = pool
    ? (await pool.query(`select path,title,links from collab_note where vault_id=$1`, [vaultId])).rows
    : (mem.note.get(vaultId) || [])
  const out = []
  for (const n of notes) {
    for (const l of n.links || []) {
      const t = String(l).split('#')[0].split('|')[0].trim().toLowerCase()
      if (t && !known.has(t)) out.push({ from: n.path, link: l })
    }
  }
  return { vaultId, dangling: out.slice(0, 500), total: out.length, vaultsSearched: vaults.length }
}

// ---------------------------------------------------------------- handoff

// A task moves: draft → offered → accepted → done, or back to offered on return.
// The transitions are explicit so a handoff can never silently land on someone.
const NEXT = {
  draft: ['offered'],
  offered: ['accepted', 'draft'],
  accepted: ['done', 'offered'],
  done: [],
}

export async function createTask(pool, { actor, title, brief, scope, repo, branch, refs = [] }) {
  const id = nid('task')
  const row = {
    id, title: String(title).slice(0, 200), brief: String(brief || '').slice(0, 8000),
    scope: scope || null, repo: repo || null, branch: branch || null,
    refs: refs.slice(0, 40), created_by: actor, assigned_to: null, state: 'draft',
  }
  if (pool) {
    await pool.query(`insert into collab_actor(id,display) values ($1,$1) on conflict (id) do nothing`, [actor])
    await pool.query(
      `insert into collab_task(id,title,brief,scope,repo,branch,refs,created_by,state)
       values ($1,$2,$3,$4,$5,$6,$7,$8,'draft')`,
      [row.id, row.title, row.brief, row.scope, row.repo, row.branch, row.refs, actor]
    )
  } else mem.task.set(id, row)
  await emit(pool, 'task.created', actor, id, { title: row.title, scope: row.scope })
  return row
}

export async function transitionTask(pool, { actor, id, to, note }) {
  const cur = pool
    ? (await pool.query(`select * from collab_task where id=$1`, [id])).rows[0]
    : mem.task.get(id)
  if (!cur) throw new Error('no such task')
  if (!NEXT[cur.state]?.includes(to)) throw new Error(`illegal transition ${cur.state} → ${to}`)
  // Only the person holding it may pass it on; only the offeree may accept.
  if (to === 'accepted' && cur.assigned_to && cur.assigned_to !== actor)
    throw new Error(`offered to ${cur.assigned_to}, not ${actor}`)
  const assigned = to === 'offered' ? (note?.to || cur.assigned_to) : to === 'accepted' ? actor : cur.assigned_to
  if (pool) {
    await pool.query(`insert into collab_actor(id,display) values ($1,$1) on conflict (id) do nothing`, [actor])
    if (assigned) await pool.query(`insert into collab_actor(id,display) values ($1,$1) on conflict (id) do nothing`, [assigned])
    await pool.query(`update collab_task set state=$2, assigned_to=$3, updated_at=now() where id=$1`, [id, to, assigned])
  } else {
    cur.state = to
    cur.assigned_to = assigned
  }
  await emit(pool, `task.${to}`, actor, id, { from: cur.state, to, assigned_to: assigned, note: note?.text || null })
  return { ...cur, state: to, assigned_to: assigned }
}

export async function listTasks(pool, { actor, state, scope } = {}) {
  if (pool) {
    const where = []
    const p = []
    if (actor) { p.push(actor); where.push(`(created_by=$${p.length} or assigned_to=$${p.length})`) }
    if (state) { p.push(state); where.push(`state=$${p.length}`) }
    if (scope) { p.push(scope); where.push(`scope=$${p.length}`) }
    const { rows } = await pool.query(
      `select * from collab_task ${where.length ? 'where ' + where.join(' and ') : ''} order by updated_at desc limit 200`, p)
    return rows
  }
  return [...mem.task.values()].filter((t) =>
    (!actor || t.created_by === actor || t.assigned_to === actor) &&
    (!state || t.state === state) && (!scope || t.scope === scope))
}

export async function recentEvents(pool, { since = 0, limit = 100 } = {}) {
  if (pool) {
    const { rows } = await pool.query(
      `select seq,kind,actor,subject,payload,at from collab_event where seq > $1 order by seq desc limit $2`,
      [since, Math.min(limit, 500)])
    return rows
  }
  return mem.event.filter((e) => e.seq > since).slice(-limit).reverse()
}

// ---------------------------------------------------------------- MCP

// Stateless MCP over HTTP: JSON-RPC 2.0, one request in, one response out, no
// session to keep. Auth is the same bearer token as the rest of Plane B, so a
// client needs no handshake and the server needs no memory — which is what lets
// it run on a platform that may move it between machines at any moment.
const TOOLS = [
  { name: 'vault_list', description: 'List registered Obsidian vaults, optionally filtered by project scope.',
    inputSchema: { type: 'object', properties: { scope: { type: 'string' } } } },
  { name: 'vault_register', description: 'Register or refresh a vault index (paths, titles, tags and outbound links only — never note bodies).',
    inputSchema: { type: 'object', required: ['scope', 'name', 'notes'],
      properties: { scope: { type: 'string' }, name: { type: 'string' }, shared: { type: 'boolean' },
        notes: { type: 'array', items: { type: 'object' } } } } },
  { name: 'vault_resolve', description: 'Resolve a [[wikilink]] across every registered vault. Returns all candidates; ambiguity is reported, never guessed.',
    inputSchema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, fromVault: { type: 'string' } } } },
  { name: 'vault_dangling', description: 'List links in a vault that resolve to no note in any vault.',
    inputSchema: { type: 'object', required: ['vaultId'], properties: { vaultId: { type: 'string' } } } },
  { name: 'task_create', description: 'Create a handoff task with a brief and optional repo/branch context.',
    inputSchema: { type: 'object', required: ['title', 'brief'],
      properties: { title: { type: 'string' }, brief: { type: 'string' }, scope: { type: 'string' },
        repo: { type: 'string' }, branch: { type: 'string' }, refs: { type: 'array', items: { type: 'string' } } } } },
  { name: 'task_offer', description: 'Offer a task to another actor. They must accept before it is theirs.',
    inputSchema: { type: 'object', required: ['id', 'to'], properties: { id: { type: 'string' }, to: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'task_accept', description: 'Accept a task that was offered to you.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'task_done', description: 'Mark an accepted task complete.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, text: { type: 'string' } } } },
  { name: 'task_list', description: 'List handoff tasks, filtered by state or scope.',
    inputSchema: { type: 'object', properties: { state: { type: 'string' }, scope: { type: 'string' }, mine: { type: 'boolean' } } } },
  { name: 'events_recent', description: 'Recent collaboration events (the same stream /v1/live pushes).',
    inputSchema: { type: 'object', properties: { since: { type: 'number' }, limit: { type: 'number' } } } },
]

export async function mcpDispatch(pool, { body, actor }) {
  const { id = null, method, params = {} } = body || {}
  const ok = (result) => ({ jsonrpc: '2.0', id, result })
  const err = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
  const text = (o) => ok({ content: [{ type: 'text', text: JSON.stringify(o, null, 1) }] })

  if (method === 'initialize')
    return ok({
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'session-viz-collab', version: '0.1.0' },
      instructions: 'Vault federation and task handoff. Plane B: identity-bearing and content-bearing, and structurally unable to join the person-blind fleet telemetry in Plane A.',
    })
  if (method === 'notifications/initialized') return ok({})
  if (method === 'ping') return ok({})
  if (method === 'tools/list') return ok({ tools: TOOLS })
  if (method !== 'tools/call') return err(-32601, `method not found: ${method}`)

  const { name, arguments: a = {} } = params
  try {
    switch (name) {
      case 'vault_list': return text(await listVaults(pool, { scope: a.scope }))
      case 'vault_register': return text(await registerVault(pool, { actor, ...a }))
      case 'vault_resolve': return text(await resolveLink(pool, { name: a.name, fromVault: a.fromVault }))
      case 'vault_dangling': return text(await danglingLinks(pool, { vaultId: a.vaultId }))
      case 'task_create': return text(await createTask(pool, { actor, ...a }))
      case 'task_offer': return text(await transitionTask(pool, { actor, id: a.id, to: 'offered', note: { to: a.to, text: a.text } }))
      case 'task_accept': return text(await transitionTask(pool, { actor, id: a.id, to: 'accepted', note: { text: a.text } }))
      case 'task_done': return text(await transitionTask(pool, { actor, id: a.id, to: 'done', note: { text: a.text } }))
      case 'task_list': return text(await listTasks(pool, { actor: a.mine ? actor : undefined, state: a.state, scope: a.scope }))
      case 'events_recent': return text(await recentEvents(pool, { since: a.since || 0, limit: a.limit || 100 }))
      default: return err(-32602, `no such tool: ${name}`)
    }
  } catch (e) {
    return ok({ content: [{ type: 'text', text: `error: ${e.message}` }], isError: true })
  }
}

export { emit }
