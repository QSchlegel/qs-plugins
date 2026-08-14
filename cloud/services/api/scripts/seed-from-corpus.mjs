#!/usr/bin/env node
// qcontrib, prototype form: turn local transcripts into closed-schema findings
// and (only on explicit request) POST them to the fleet backend.
//
//   node seed-from-corpus.mjs --review                 # print what WOULD be sent
//   node seed-from-corpus.mjs --post <url> --token <t> # send it
//
// Foreground only, never a daemon. Everything egressed is one of the eleven
// closed fields — no prompt text, no path, no branch, no person. The review
// mode exists so the literal payload can be read before anything leaves.
//
// This also implements a minimal terminal/delivery classifier (a slice of the
// planned M1): a second streaming pass per transcript for stop_reason, tool
// result resolution and write outcomes — fields the session extractor does
// not yet compute.

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { extract, listSessions } from '../../../../plugins/session-viz/scripts/extract.mjs'

// ---------------------------------------------------------------- helpers

function isoWeek(dateIso) {
  const d0 = new Date(dateIso)
  const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()))
  const day = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - day + 3)
  const year = d.getUTCFullYear()
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const week = 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
  return `${year}-W${String(week).padStart(2, '0')}`
}

const band = (v) => (v && /^\d+\.\d+\.\d+$/.test(v) ? v.replace(/\d$/, 'x') : '0.0.x')
const bucket = (n, cap) => Math.min(cap, Math.round(Math.log2(1 + Math.max(0, n))))
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'unknown'

// ---------------------------------------------------------------- tail pass

// One streaming pass per file for what extract.mjs throws away: the terminal
// record shape, tool_use↔tool_result resolution, and write outcomes.
async function tailFacts(file) {
  const facts = {
    lastStop: null, lastToolName: null, lastToolId: null,
    resolved: new Set(), toolNames: new Map(),
    writeOk: false, writeErr: false, toolErrs: 0,
    permission: false, auth: false, scheduledName: null, toolCalls: 0,
  }
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    let r
    try { r = JSON.parse(line) } catch { continue }
    if (r.type === 'assistant') {
      if (r.message?.stop_reason !== undefined) facts.lastStop = r.message.stop_reason
      for (const b of r.message?.content || []) {
        if (b.type !== 'tool_use') continue
        facts.toolCalls++
        facts.lastToolName = b.name
        facts.lastToolId = b.id
        facts.toolNames.set(b.id, b.name)
      }
    } else if (r.type === 'user') {
      const content = r.message?.content
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type !== 'tool_result') continue
          facts.resolved.add(b.tool_use_id)
          const name = facts.toolNames.get(b.tool_use_id)
          const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
          if (b.is_error) {
            facts.toolErrs++
            if (/permission|denied|approv|allowlist/i.test(text)) facts.permission = true
            if (/401|unauthoriz|authentication/i.test(text)) facts.auth = true
            if (name === 'Write' || name === 'Edit') facts.writeErr = true
          } else if (name === 'Write' || name === 'Edit') {
            facts.writeOk = true
          }
        }
      }
      if (!facts.scheduledName && typeof content === 'string') {
        const m = content.match(/<scheduled-task name="([^"]+)"/)
        if (m) facts.scheduledName = m[1]
      } else if (!facts.scheduledName && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'text' && typeof b.text === 'string') {
            const m = b.text.match(/<scheduled-task name="([^"]+)"/)
            if (m) { facts.scheduledName = m[1]; break }
          }
        }
      }
    }
  }
  return facts
}

// Ordered rules — see the RUN-spine design. RETURN_SET is the one
// hand-maintained constant; StructuredOutput ending a run is success.
const RETURN_SET = new Set(['StructuredOutput'])
function terminalState(f) {
  if (f.lastStop === 'end_turn') return 'completed_prose'
  if (f.lastStop === 'tool_use' && f.lastToolId) {
    const resolved = f.resolved.has(f.lastToolId)
    if (RETURN_SET.has(f.lastToolName) && resolved) return 'completed_structured'
    if (!resolved) return 'abandoned_mid_tool'
    return 'truncated'
  }
  if (f.lastStop === 'stop_sequence') return 'infra_halt'
  if (!f.lastStop && f.toolCalls === 0) return 'zombie'
  return 'unknown'
}

// ---------------------------------------------------------------- build

const findings = []
for (const s of listSessions()) {
  let session
  try { session = await extract(s.file) } catch { continue }
  if (!session.startedAt) continue
  const facts = await tailFacts(s.file)
  const human = session.totals.humanTurns > 0
  findings.push({
    kind: human ? 'human_session' : 'scheduled',
    task_class: human ? 'human' : slug(facts.scheduledName),
    cli_band: band(session.version),
    iso_week: isoWeek(session.startedAt),
    terminal_state: terminalState(facts),
    delivery_state: facts.writeErr ? 'denied' : facts.writeOk ? 'wrote_ok' : 'no_intent',
    error_class: facts.permission ? 'permission' : facts.auth ? 'auth' : facts.toolErrs > 0 ? 'tool_error' : 'none',
    cost_bucket: bucket(session.totals.tokens.output, 40),
    tool_bucket: bucket(session.totals.toolCalls, 14),
  })
}

// ---------------------------------------------------------------- cli

const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }

const tally = (key) => {
  const t = {}
  for (const f of findings) t[f[key]] = (t[f[key]] || 0) + 1
  return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join('  ')
}

console.error(`findings built : ${findings.length} (depth-2 sessions only; subagents not yet ingested)`)
console.error(`kind           : ${tally('kind')}`)
console.error(`task_class     : ${tally('task_class')}`)
console.error(`terminal_state : ${tally('terminal_state')}`)
console.error(`delivery_state : ${tally('delivery_state')}`)
console.error(`error_class    : ${tally('error_class')}`)

if (argv.includes('--review')) {
  console.log(JSON.stringify({ findings }, null, 1))
  process.exit(0)
}

const url = opt('--post')
const token = opt('--token')
if (url && token) {
  const res = await fetch(url.replace(/\/$/, '') + '/v1/contrib', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ findings }),
  })
  const body = await res.json()
  console.error(`POST ${url} → ${res.status} accepted=${body.accepted} rejected=${body.rejected?.length ?? '?'}`)
  if (body.rejected?.length) console.error(JSON.stringify(body.rejected.slice(0, 5), null, 1))
  process.exit(res.ok ? 0 : 1)
}

if (!argv.includes('--review')) console.error('\nnothing sent — use --review to print, or --post <url> --token <t> to send')
