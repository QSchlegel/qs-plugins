#!/usr/bin/env node
// Authentication and tenancy (Mandantenfähigkeit).
//
// Two factors offered, both passwordless:
//   - email + one-time code — works everywhere, no enrolment step
//   - passkey (WebAuthn)    — phishing-resistant, needs one enrolment
//
// ── What multi-tenancy changes about the honesty model ──────────────────────
// Plane B rows are tenant-scoped and never leave their tenant: a vault, a task
// and an event all carry `tenant`, and every query filters on it.
//
// Plane A is the interesting case. Aggregating findings ACROSS tenants is the
// entire value of the reference table — it is where the sample size finally
// exists. But a k-gate counting only findings is not enough once there are
// tenants: one heavy customer could supply every finding in a cell and the
// "fleet" number would be that customer's number wearing a crowd's clothes.
// So the gate gains a second condition — a cell must draw on at least
// MIN_TENANTS distinct tenants — and cells suppressed for that reason are
// counted separately, so the report can say which constraint bit.

import crypto from 'node:crypto'

export const OTP_TTL_MS = 10 * 60 * 1000
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
const OTP_MAX_ATTEMPTS = 5
const OTP_RATE_WINDOW_MS = 15 * 60 * 1000
const OTP_RATE_MAX = 5
const OTP_RESEND_FLOOR_MS = 45 * 1000

const b64u = (buf) => Buffer.from(buf).toString('base64url')
const fromB64u = (s) => Buffer.from(String(s), 'base64url')
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const nid = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`
const normEmail = (e) => String(e || '').trim().toLowerCase().slice(0, 254)
const validEmail = (e) => /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(e)

// Codes are stored only as a hash. A leaked table must not be a leaked inbox.
const hashCode = (code, salt) => crypto.createHmac('sha256', salt).update(code).digest('hex')
const constEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

// ---------------------------------------------------------------- schema

export async function initAuth(pool) {
  if (!pool) return
  await pool.query(`create table if not exists tenant(
    id text primary key,
    name text not null,
    plan text not null default 'fleet',
    created_at timestamptz not null default now()
  )`)
  // Two tenancy levels:
  //   L1  tenant  — the customer. Billed, owns the workspace, has admins.
  //   L2  account — a member inside it. Invited and managed by an admin.
  // `role` is the only thing separating them, and it is checked server-side on
  // every administrative call — never inferred from what the UI offered.
  await pool.query(`create table if not exists account(
    id text primary key,
    tenant text not null references tenant(id) on delete cascade,
    email text not null,
    display text,
    role text not null default 'member',
    status text not null default 'active',
    invited_by text,
    created_at timestamptz not null default now(),
    unique (email)
  )`)
  await pool.query(`alter table account add column if not exists role text not null default 'member'`)
  await pool.query(`alter table account add column if not exists status text not null default 'active'`)
  await pool.query(`alter table account add column if not exists invited_by text`)
  await pool.query(`create table if not exists invite(
    id text primary key,
    tenant text not null references tenant(id) on delete cascade,
    email text not null,
    role text not null default 'member',
    invited_by text not null,
    accepted_at timestamptz,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    unique (tenant, email)
  )`)
  await pool.query(`create table if not exists otp(
    email text primary key,
    tenant text,
    salt text not null,
    code_hash text not null,
    attempts int not null default 0,
    sent_at timestamptz not null default now(),
    expires_at timestamptz not null,
    rate int not null default 0,
    rate_since timestamptz not null default now()
  )`)
  // These two columns were read by otpStart but never created, so `prev.rate`
  // was always undefined and the 15-minute cap could not fire — the only limit
  // actually running was the 45-second floor. Added separately as well as in
  // the create, because production's otp table already exists.
  await pool.query(`alter table otp add column if not exists rate int not null default 0`)
  await pool.query(`alter table otp add column if not exists rate_since timestamptz not null default now()`)
  await pool.query(`create table if not exists passkey(
    cred_id text primary key,
    account text not null references account(id) on delete cascade,
    public_key text not null,
    alg int not null,
    sign_count bigint not null default 0,
    label text,
    created_at timestamptz not null default now()
  )`)
  await pool.query(`create table if not exists webauthn_challenge(
    id text primary key,
    email text,
    challenge text not null,
    kind text not null,
    expires_at timestamptz not null
  )`)
  await pool.query(`create table if not exists session(
    token_hash text primary key,
    account text not null references account(id) on delete cascade,
    tenant text not null,
    method text not null,
    created_at timestamptz not null default now(),
    expires_at timestamptz not null
  )`)
  // Tenancy columns on plane B. Added idempotently so an existing deployment
  // migrates without a separate step.
  for (const t of ['collab_vault', 'collab_task', 'collab_event', 'collab_actor']) {
    await pool.query(`alter table ${t} add column if not exists tenant text`)
    await pool.query(`create index if not exists ${t}_tenant_ix on ${t}(tenant)`)
  }
  // Plane A gains a tenant column too — for accounting and for the
  // distinct-tenant gate. It is never exposed in any per-tenant breakdown of
  // another tenant's data, and it is still not a person.
  await pool.query(`alter table finding add column if not exists tenant text`)
  await pool.query(`create index if not exists finding_tenant_ix on finding(tenant)`)
}

// ---------------------------------------------------------------- tenants

export async function ensureTenant(pool, { id, name, plan = 'fleet' }, mem) {
  const tid = id || nid('t')
  if (!pool) { mem.tenant.set(tid, { id: tid, name: name || tid, plan }); return { id: tid, name: name || tid, plan } }
  await pool.query(
    `insert into tenant(id,name,plan) values ($1,$2,$3)
     on conflict (id) do update set name=excluded.name`, [tid, name || tid, plan])
  return { id: tid, name: name || tid, plan }
}

// Email domain decides the tenant, which is the behaviour every B2B tool has
// and the one users expect: two colleagues land in the same workspace without
// an invite dance. A free-mail domain gets its own single-seat tenant instead
// of pooling every gmail user into one shared workspace.
const FREEMAIL = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'yahoo.com', 'proton.me', 'protonmail.com', 'icloud.com', 'gmx.de', 'web.de'])
export const tenantForEmail = (email) => {
  const domain = normEmail(email).split('@')[1] || ''
  if (!domain) return null
  return FREEMAIL.has(domain)
    ? 't_' + crypto.createHash('sha256').update(normEmail(email)).digest('hex').slice(0, 16)
    : 't_' + domain.replace(/[^a-z0-9]+/g, '-')
}

// ---------------------------------------------------------------- email OTP

const TOO_SOON = 'a code was just sent — check your inbox'
const TOO_MANY = 'too many codes requested — wait a few minutes'

// This route is unauthenticated and takes the address from the request body, so
// it is the one place a stranger can make the service send mail to a third
// party. The limit is therefore load-bearing twice over: it protects the
// recipient from being mailbombed with codes they never asked for, and it
// protects the Resend quota from being drained by anyone with curl.
export async function otpStart(pool, mem, { email, deliver }) {
  const e = normEmail(email)
  if (!validEmail(e)) throw new Error('invalid email')
  const now = Date.now()
  // Six digits from rejection-free randomness. Not a token — it is short-lived,
  // single-purpose and rate-limited, and it is never stored in the clear.
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
  const salt = crypto.randomBytes(16).toString('hex')
  const expires = new Date(now + OTP_TTL_MS)

  if (pool) {
    // One statement decides and writes. The previous form read sent_at in a
    // SELECT and then wrote in a separate UPSERT, so two concurrent requests
    // could both read the same value, both conclude the floor had passed, and
    // both send. Here the predicate is evaluated against the row being updated
    // under its own lock: the loser writes nothing, returns nothing, and no
    // mail goes out. The window counter resets rather than sliding, which is
    // coarser than a true sliding window and deliberately so — it costs one
    // column instead of a table of timestamps.
    const { rows } = await pool.query(
      `insert into otp(email,tenant,salt,code_hash,attempts,sent_at,expires_at,rate,rate_since)
       values ($1,$2,$3,$4,0,now(),$5,1,now())
       on conflict (email) do update set
         salt = excluded.salt,
         code_hash = excluded.code_hash,
         attempts = 0,
         sent_at = now(),
         expires_at = excluded.expires_at,
         rate = case when otp.rate_since < now() - make_interval(secs => $7::double precision)
                     then 1 else otp.rate + 1 end,
         rate_since = case when otp.rate_since < now() - make_interval(secs => $7::double precision)
                           then now() else otp.rate_since end
       where otp.sent_at < now() - make_interval(secs => $6::double precision)
         and (otp.rate_since < now() - make_interval(secs => $7::double precision)
              or otp.rate < $8)
       returning rate`,
      [e, tenantForEmail(e), salt, hashCode(code, salt), expires,
        OTP_RESEND_FLOOR_MS / 1000, OTP_RATE_WINDOW_MS / 1000, OTP_RATE_MAX])
    if (!rows.length) {
      // Nothing was written, so nothing may be sent. The extra read exists only
      // to pick the right message, and only runs on the rejected path.
      const cur = (await pool.query(`select sent_at from otp where email=$1`, [e])).rows[0]
      const since = cur ? now - new Date(cur.sent_at).getTime() : Infinity
      throw new Error(since < OTP_RESEND_FLOOR_MS ? TOO_SOON : TOO_MANY)
    }
  } else {
    const prev = mem.otp.get(e)
    let rate = 1, rateSince = now
    if (prev) {
      const sent = new Date(prev.sent_at).getTime()
      const since = new Date(prev.rate_since ?? prev.sent_at).getTime()
      const fresh = now - since >= OTP_RATE_WINDOW_MS
      if (now - sent < OTP_RESEND_FLOOR_MS) throw new Error(TOO_SOON)
      if (!fresh && (prev.rate || 0) >= OTP_RATE_MAX) throw new Error(TOO_MANY)
      rate = fresh ? 1 : (prev.rate || 0) + 1
      rateSince = fresh ? now : since
    }
    mem.otp.set(e, {
      email: e, salt, code_hash: hashCode(code, salt), attempts: 0,
      sent_at: new Date(now), expires_at: expires, rate, rate_since: new Date(rateSince),
    })
  }
  await deliver({ email: e, code, expiresInMinutes: OTP_TTL_MS / 60000 })
  return { sent: true, expiresAt: expires.toISOString() }
}

export async function otpVerify(pool, mem, { email, code }) {
  const e = normEmail(email)
  const row = pool
    ? (await pool.query(`select * from otp where email=$1`, [e])).rows[0]
    : mem.otp.get(e)
  if (!row) throw new Error('no code outstanding')
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('code expired')
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new Error('too many attempts')
  const ok = constEq(hashCode(String(code || '').trim(), row.salt), row.code_hash)
  if (!ok) {
    if (pool) await pool.query(`update otp set attempts=attempts+1 where email=$1`, [e])
    else row.attempts++
    throw new Error('wrong code')
  }
  if (pool) await pool.query(`delete from otp where email=$1`, [e])
  else mem.otp.delete(e)
  return issueSession(pool, mem, { email: e, method: 'otp' })
}

// ---------------------------------------------------------------- sessions

export async function issueSession(pool, mem, { email, method }) {
  const e = normEmail(email)
  const tenantId = tenantForEmail(e)
  await ensureTenant(pool, { id: tenantId, name: e.split('@')[1] || e }, mem)
  let acct
  if (pool) {
    const r = await pool.query(
      `insert into account(id,tenant,email) values ($1,$2,$3)
       on conflict (email) do update set email=excluded.email returning *`,
      [nid('a'), tenantId, e])
    acct = r.rows[0]
  } else {
    acct = [...mem.account.values()].find((a) => a.email === e)
    if (!acct) {
      // Same defaults the table declares; the in-memory store is a test double,
      // so it must not disagree with Postgres about what an account is.
      acct = { id: nid('a'), tenant: tenantId, email: e, role: 'member', status: 'active', invited_by: null }
      mem.account.set(acct.id, acct)
    }
  }
  if (acct.status === 'suspended') throw new Error('this account is suspended — ask your team admin')
  // An outstanding invite decides the role on first sign-in; otherwise the very
  // first account in a tenant becomes its admin.
  const invKey = `${tenantId}|${e}`
  const inv = pool
    ? (await pool.query(`select * from invite where tenant=$1 and email=$2 and accepted_at is null`, [tenantId, e])).rows[0]
    : mem.invite.get(invKey)
  if (inv && new Date(inv.expires_at).getTime() > Date.now()) {
    if (pool) {
      await pool.query(`update account set role=$2, invited_by=$3 where id=$1`, [acct.id, inv.role, inv.invited_by])
      await pool.query(`update invite set accepted_at=now() where tenant=$1 and email=$2`, [tenantId, e])
    } else { acct.role = inv.role; mem.invite.delete(invKey) }
    acct.role = inv.role
  } else {
    await claimFirstAdmin(pool, mem, { tenant: tenantId, accountId: acct.id })
    const fresh = await loadAccount(pool, mem, acct.id)
    if (fresh) acct.role = fresh.role
  }

  const token = crypto.randomBytes(32).toString('base64url')
  const expires = new Date(Date.now() + SESSION_TTL_MS)
  const th = sha256(token).toString('hex')
  if (pool) {
    await pool.query(`insert into session(token_hash,account,tenant,method,expires_at) values ($1,$2,$3,$4,$5)`,
      [th, acct.id, acct.tenant, method, expires])
  } else {
    mem.session.set(th, { account: acct.id, tenant: acct.tenant, method, expires_at: expires })
  }
  return { token, account: acct.id, tenant: acct.tenant, email: e, role: acct.role || 'member', method, expiresAt: expires.toISOString() }
}

export async function resolveSession(pool, mem, token) {
  if (!token) return null
  const th = sha256(String(token)).toString('hex')
  const row = pool
    ? (await pool.query(
        `select s.account, s.tenant, s.method, s.expires_at, a.email, a.role, a.status
         from session s join account a on a.id = s.account where s.token_hash=$1`, [th])).rows[0]
    : (() => {
        const s = mem.session.get(th)
        if (!s) return null
        const a = mem.account.get(s.account)
        return { ...s, email: a?.email, role: a?.role, status: a?.status }
      })()
  if (!row) return null
  if (new Date(row.expires_at).getTime() < Date.now()) return null
  if (row.status === 'suspended') return null
  return row
}

export async function revokeSession(pool, mem, token) {
  const th = sha256(String(token || '')).toString('hex')
  if (pool) await pool.query(`delete from session where token_hash=$1`, [th])
  else mem.session.delete(th)
  return { revoked: true }
}

// ---------------------------------------------------------------- WebAuthn

// A minimal CBOR reader — only the subset an attestationObject and a COSE key
// use. Pulling a CBOR library in for this would be the larger risk: this
// decoder refuses anything it does not understand rather than guessing.
function cbor(buf, i = 0) {
  const type = buf[i] >> 5, info = buf[i] & 31
  i++
  let len = info
  if (info === 24) { len = buf[i]; i += 1 }
  else if (info === 25) { len = buf.readUInt16BE(i); i += 2 }
  else if (info === 26) { len = buf.readUInt32BE(i); i += 4 }
  else if (info === 27) { len = Number(buf.readBigUInt64BE(i)); i += 8 }
  else if (info > 27) throw new Error('cbor: unsupported additional info')
  switch (type) {
    case 0: return [len, i]
    case 1: return [-1 - len, i]
    case 2: return [buf.subarray(i, i + len), i + len]
    case 3: return [buf.subarray(i, i + len).toString('utf8'), i + len]
    case 4: { const a = []; for (let n = 0; n < len; n++) { const [v, j] = cbor(buf, i); a.push(v); i = j } return [a, i] }
    case 5: { const m = new Map(); for (let n = 0; n < len; n++) { const [k, j] = cbor(buf, i); const [v, j2] = cbor(buf, j); m.set(k, v); i = j2 } return [m, i] }
    case 7: if (info === 20) return [false, i]; if (info === 21) return [true, i]; if (info === 22) return [null, i]
      throw new Error('cbor: unsupported simple value')
    default: throw new Error('cbor: unsupported major type ' + type)
  }
}

// COSE → SPKI, for the two algorithms worth supporting: ES256 (nearly every
// platform authenticator) and Ed25519.
function coseToKey(cose) {
  const kty = cose.get(1), alg = cose.get(3)
  if (kty === 2 && alg === -7) {
    const x = cose.get(-2), y = cose.get(-3)
    if (!x || !y || x.length !== 32 || y.length !== 32) throw new Error('bad EC2 key')
    const der = Buffer.concat([
      Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'),
      Buffer.from([0x04]), x, y,
    ])
    return { key: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), alg }
  }
  if (kty === 1 && alg === -8) {
    const x = cose.get(-2)
    if (!x || x.length !== 32) throw new Error('bad OKP key')
    const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), x])
    return { key: crypto.createPublicKey({ key: der, format: 'der', type: 'spki' }), alg }
  }
  throw new Error(`unsupported COSE algorithm ${alg} (kty ${kty}) — ES256 or Ed25519 only`)
}

const checkClientData = (clientDataJSON, expected, { origin, rpId }) => {
  const cd = JSON.parse(fromB64u(clientDataJSON).toString('utf8'))
  if (cd.type !== expected) throw new Error(`clientData.type ${cd.type}`)
  if (!constEq(cd.challenge, expected === 'webauthn.create' ? cd.challenge : cd.challenge)) throw new Error('challenge mismatch')
  if (origin && cd.origin !== origin) throw new Error(`origin ${cd.origin} != ${origin}`)
  return cd
}

export async function passkeyChallenge(pool, mem, { email, kind }) {
  const e = email ? normEmail(email) : null
  const challenge = crypto.randomBytes(32).toString('base64url')
  const id = nid('wac')
  const expires = new Date(Date.now() + 5 * 60 * 1000)
  if (pool) await pool.query(`insert into webauthn_challenge(id,email,challenge,kind,expires_at) values ($1,$2,$3,$4,$5)`,
    [id, e, challenge, kind, expires])
  else mem.wac.set(id, { id, email: e, challenge, kind, expires_at: expires })
  return { challengeId: id, challenge, expiresAt: expires.toISOString() }
}

const takeChallenge = async (pool, mem, id, kind) => {
  const row = pool
    ? (await pool.query(`delete from webauthn_challenge where id=$1 returning *`, [id])).rows[0]
    : (() => { const r = mem.wac.get(id); mem.wac.delete(id); return r })()
  if (!row) throw new Error('unknown or already-used challenge')
  if (row.kind !== kind) throw new Error('challenge kind mismatch')
  if (new Date(row.expires_at).getTime() < Date.now()) throw new Error('challenge expired')
  return row
}

// The address is taken from the caller's session and from nowhere else.
//
// This previously read `email || ch.email`, preferring an address supplied in
// the request body. Nothing on this path proves control of that address: the
// route is unauthenticated, the clientData origin and the rpIdHash are fields
// the caller writes into its own payload, and the attestation statement is
// never verified — so a plain HTTP client could mint a credential locally,
// bind it to any address including a sitting tenant admin's, and then sign in
// as them through passkeyLogin. issueSession upserts on email, so the target
// did not even have to be a new account. No mail was sent, so it was silent.
//
// `sessionEmail` is supplied by the route from a resolved bearer token. Any
// `email` in the body is ignored — it is not in the destructure at all.
export async function passkeyRegister(pool, mem, { challengeId, sessionEmail, credential, origin, rpId, label }) {
  const e = normEmail(sessionEmail)
  if (!validEmail(e)) throw new Error('sign in before adding a passkey')
  const ch = await takeChallenge(pool, mem, challengeId, 'register')
  // Defence in depth: the challenge is minted against the signed-in address, so
  // a challenge fetched by one account cannot be redeemed by another.
  if (ch.email && normEmail(ch.email) !== e) throw new Error('challenge belongs to a different account')
  const cd = JSON.parse(fromB64u(credential.response.clientDataJSON).toString('utf8'))
  if (cd.type !== 'webauthn.create') throw new Error('wrong clientData type')
  if (!constEq(cd.challenge, ch.challenge)) throw new Error('challenge mismatch')
  if (origin && cd.origin !== origin) throw new Error(`origin ${cd.origin} rejected`)

  const [att] = cbor(fromB64u(credential.response.attestationObject))
  const authData = att.get('authData')
  if (!authData || authData.length < 37) throw new Error('missing authData')
  if (!constEq(authData.subarray(0, 32).toString('hex'), sha256(rpId || '').toString('hex')))
    throw new Error('rpIdHash mismatch')
  const flags = authData[32]
  if (!(flags & 0x01)) throw new Error('user not present')
  if (!(flags & 0x40)) throw new Error('no attested credential data')
  const credIdLen = authData.readUInt16BE(53)
  const credId = authData.subarray(55, 55 + credIdLen)
  const [cose] = cbor(authData.subarray(55 + credIdLen))
  const { key, alg } = coseToKey(cose)
  const spki = key.export({ type: 'spki', format: 'pem' })

  // No issueSession here any more. It was upserting the account row, which is
  // what allowed enrolment to conjure an account for an address the caller did
  // not control — and it minted a second session nobody used. The caller is
  // already signed in, so the row exists; if it does not, that is a bug worth
  // failing on rather than papering over with an insert.
  const acct = pool
    ? (await pool.query(`select id from account where email=$1`, [e])).rows[0]
    : [...mem.account.values()].find((a) => a.email === e)
  if (!acct) throw new Error('no account for this session')
  if (pool) {
    await pool.query(
      `insert into passkey(cred_id,account,public_key,alg,sign_count,label) values ($1,$2,$3,$4,$5,$6)
       on conflict (cred_id) do nothing`,
      [b64u(credId), acct.id, spki, alg, Number(authData.readUInt32BE(33)), label || null])
  } else {
    mem.passkey.set(b64u(credId), { cred_id: b64u(credId), account: acct.id, public_key: spki, alg, sign_count: authData.readUInt32BE(33) })
  }
  return { registered: true, credentialId: b64u(credId), alg }
}

export async function passkeyLogin(pool, mem, { challengeId, credential, origin, rpId }) {
  const ch = await takeChallenge(pool, mem, challengeId, 'login')
  const credId = credential.id
  const pk = pool
    ? (await pool.query(
        `select p.*, a.email from passkey p join account a on a.id = p.account where p.cred_id=$1`, [credId])).rows[0]
    : (() => { const p = mem.passkey.get(credId); return p ? { ...p, email: mem.account.get(p.account)?.email } : null })()
  if (!pk) throw new Error('unknown credential')

  const cd = JSON.parse(fromB64u(credential.response.clientDataJSON).toString('utf8'))
  if (cd.type !== 'webauthn.get') throw new Error('wrong clientData type')
  if (!constEq(cd.challenge, ch.challenge)) throw new Error('challenge mismatch')
  if (origin && cd.origin !== origin) throw new Error(`origin ${cd.origin} rejected`)

  const authData = fromB64u(credential.response.authenticatorData)
  if (!constEq(authData.subarray(0, 32).toString('hex'), sha256(rpId || '').toString('hex')))
    throw new Error('rpIdHash mismatch')
  if (!(authData[32] & 0x01)) throw new Error('user not present')

  const signed = Buffer.concat([authData, sha256(fromB64u(credential.response.clientDataJSON))])
  const sig = fromB64u(credential.response.signature)
  const key = crypto.createPublicKey(pk.public_key)
  const ok = pk.alg === -8
    ? crypto.verify(null, signed, key, sig)
    : crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, sig)
  if (!ok) throw new Error('signature verification failed')

  // Counter regression is the documented cloned-authenticator signal. Many
  // platform authenticators legitimately report 0 forever, so a zero counter is
  // accepted and only a genuine decrease is refused.
  const newCount = authData.readUInt32BE(33)
  if (newCount !== 0 && Number(pk.sign_count) !== 0 && newCount <= Number(pk.sign_count))
    throw new Error('signature counter did not advance — possible cloned authenticator')
  if (pool) await pool.query(`update passkey set sign_count=$2 where cred_id=$1`, [credId, newCount])
  else pk.sign_count = newCount

  return issueSession(pool, mem, { email: pk.email, method: 'passkey' })
}

export const authMem = () => ({
  tenant: new Map(), account: new Map(), session: new Map(),
  otp: new Map(), passkey: new Map(), wac: new Map(), invite: new Map(),
})

// ---------------------------------------------------------------- L1 / L2

export const ROLES = ['admin', 'member']
const INVITE_TTL_MS = 14 * 24 * 60 * 60 * 1000

export async function loadAccount(pool, mem, id) {
  if (pool) return (await pool.query(`select * from account where id=$1`, [id])).rows[0] || null
  return mem.account.get(id) || null
}

export const requireAdmin = (acct) => {
  if (!acct) throw new Error('not signed in')
  if (acct.role !== 'admin') throw new Error('team admin required')
  return acct
}

// The first account in a tenant becomes its admin. Every later one is a member
// until an admin promotes them — so a workspace is never adminless, and a
// colleague signing up second cannot silently gain control of it.
export async function claimFirstAdmin(pool, mem, { tenant, accountId }) {
  if (pool) {
    const { rows } = await pool.query(`select count(*)::int as n from account where tenant=$1 and role='admin'`, [tenant])
    if (rows[0].n === 0) await pool.query(`update account set role='admin' where id=$1`, [accountId])
    return rows[0].n === 0
  }
  const existing = [...mem.account.values()].filter((a) => a.tenant === tenant && a.role === 'admin')
  if (!existing.length) { const a = mem.account.get(accountId); if (a) a.role = 'admin'; return true }
  return false
}

export async function listMembers(pool, mem, { tenant }) {
  if (pool) {
    const { rows } = await pool.query(
      `select id,email,display,role,status,created_at from account where tenant=$1 order by role, email`, [tenant])
    return rows
  }
  return [...mem.account.values()].filter((a) => a.tenant === tenant)
}

export async function inviteMember(pool, mem, { admin, email, role = 'member' }) {
  requireAdmin(admin)
  const e = normEmail(email)
  if (!validEmail(e)) throw new Error('invalid email')
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`)
  // An invite may not pull someone into a tenant their email does not belong
  // to; otherwise a workspace could annex another company's staff.
  const natural = tenantForEmail(e)
  if (natural !== admin.tenant) throw new Error(`${e} belongs to ${natural}, not ${admin.tenant}`)
  const id = nid('inv')
  const expires = new Date(Date.now() + INVITE_TTL_MS)
  if (pool) {
    await pool.query(
      `insert into invite(id,tenant,email,role,invited_by,expires_at) values ($1,$2,$3,$4,$5,$6)
       on conflict (tenant,email) do update set role=excluded.role, invited_by=excluded.invited_by,
         expires_at=excluded.expires_at, accepted_at=null`,
      [id, admin.tenant, e, role, admin.id, expires])
  } else mem.invite.set(`${admin.tenant}|${e}`, { id, tenant: admin.tenant, email: e, role, invited_by: admin.id, expires_at: expires })
  return { invited: e, role, tenant: admin.tenant, expiresAt: expires.toISOString() }
}

export async function setRole(pool, mem, { admin, accountId, role }) {
  requireAdmin(admin)
  if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(', ')}`)
  const target = await loadAccount(pool, mem, accountId)
  if (!target || target.tenant !== admin.tenant) throw new Error('no such member in this tenant')
  // Refuse to remove the last admin: a workspace with no administrator can only
  // be repaired by us, which is a support ticket the design should not create.
  if (target.role === 'admin' && role !== 'admin') {
    const members = await listMembers(pool, mem, { tenant: admin.tenant })
    if (members.filter((m) => m.role === 'admin').length <= 1) throw new Error('cannot demote the last admin')
  }
  if (pool) await pool.query(`update account set role=$2 where id=$1`, [accountId, role])
  else mem.account.get(accountId).role = role
  return { id: accountId, role }
}

export async function setStatus(pool, mem, { admin, accountId, status }) {
  requireAdmin(admin)
  if (!['active', 'suspended'].includes(status)) throw new Error('status must be active or suspended')
  const target = await loadAccount(pool, mem, accountId)
  if (!target || target.tenant !== admin.tenant) throw new Error('no such member in this tenant')
  if (target.id === admin.id) throw new Error('cannot suspend yourself')
  if (pool) {
    await pool.query(`update account set status=$2 where id=$1`, [accountId, status])
    // Suspension takes effect immediately, not at next token expiry.
    if (status === 'suspended') await pool.query(`delete from session where account=$1`, [accountId])
  } else {
    mem.account.get(accountId).status = status
    if (status === 'suspended') for (const [k, v] of mem.session) if (v.account === accountId) mem.session.delete(k)
  }
  return { id: accountId, status }
}
