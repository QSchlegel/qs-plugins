#!/usr/bin/env node
// The RUN spine: every transcript on the machine, not just the ones with a
// human in them.
//
//   node runs.mjs                 # delivery ledger, text
//   node runs.mjs --cost          # token economy by agent family
//   node runs.mjs --json          # full model
//
// extract.mjs and corpus.mjs deliberately discard two populations to keep the
// prompting statistics honest: scheduled runs with no human turns, and the
// subagent transcripts nested under <session>/subagents/**. Those are the
// majority of runs and almost all of the token spend, so this reads them.
//
// A run is a task, a trajectory, an outcome and a cost. A human session is a
// run that happens to contain human turns — that is a field, not a subsystem.

import { readdirSync, statSync, createReadStream } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'

const PROJECTS = join(homedir(), '.claude', 'projects')

// The one hand-maintained constant in the classifier. A run that ends by
// calling a return tool has SUCCEEDED; without this list, "ended on a tool
// call" looks like failure and condemns most of a healthy fleet.
const RETURN_SET = new Set(['StructuredOutput'])

const WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

function* walk(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) yield* walk(full)
    else if (e.name.endsWith('.jsonl')) yield full
  }
}

const isoWeek = (iso) => {
  const d0 = new Date(iso)
  const d = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3)
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4))
  const wk = 1 + Math.round(((d - jan4) / 864e5 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7)
  return `${d.getUTCFullYear()}-W${String(wk).padStart(2, '0')}`
}

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)

// Family from the opening instruction. A heuristic, and labelled as one
// wherever it is reported — the boundaries between these are fuzzy.
function familyOf(text) {
  const t = (text || '').toLowerCase()
  if (/refute|verify|adversarial|skeptic|critique/.test(t)) return 'verifier'
  if (/\bedit\b|patch|apply the fix|scoped/.test(t)) return 'scoped-editor'
  if (/translat/.test(t)) return 'translator'
  if (/note|summar|digest|brief/.test(t)) return 'note-writer'
  return 'other'
}

async function scanRun(file) {
  const r = {
    started: null, agentEnded: null, lastRecord: null,
    out: 0, cin: 0, cread: 0, ccreate: 0,
    tools: 0, toolErr: 0, humanTurns: 0,
    lastStop: null, lastTool: null, lastToolId: null, resolved: new Set(),
    firstText: '', schedName: null, models: new Map(),
    structured: 0, structuredFail: 0,
    intentWrite: 0, wroteOk: 0, writeDenied: 0,
    permission: false, auth: false, loops: 0,
    toolCounts: new Map(),
  }
  const names = new Map()
  const lastInput = new Map()
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity })
  for await (const line of rl) {
    let o
    try { o = JSON.parse(line) } catch { continue }
    const ts = o.timestamp
    if (ts) { if (!r.started) r.started = ts; r.lastRecord = ts }

    if (o.type === 'assistant') {
      // The last ASSISTANT timestamp, not the last record: a human reopening a
      // session hours later must not be counted as agent runtime. One session
      // in the reference corpus reads as 14,041 minutes and ran for two.
      if (ts) r.agentEnded = ts
      const m = o.message?.model
      if (m && m !== '<synthetic>') r.models.set(m, (r.models.get(m) || 0) + 1)
      const u = o.message?.usage || {}
      r.out += u.output_tokens || 0
      r.cin += u.input_tokens || 0
      r.cread += u.cache_read_input_tokens || 0
      r.ccreate += u.cache_creation_input_tokens || 0
      if (o.message?.stop_reason !== undefined) r.lastStop = o.message.stop_reason
      for (const b of o.message?.content || []) {
        if (b.type !== 'tool_use') continue
        r.tools++
        r.lastTool = b.name; r.lastToolId = b.id
        names.set(b.id, b.name)
        r.toolCounts.set(b.name, (r.toolCounts.get(b.name) || 0) + 1)
        if (b.name === 'StructuredOutput') r.structured++
        if (WRITE_TOOLS.has(b.name)) r.intentWrite++
        // Loop detection: the same tool with the same input, back to back.
        const key = b.name + '|' + JSON.stringify(b.input || {}).slice(0, 300)
        if (lastInput.get(b.name) === key) r.loops++
        lastInput.set(b.name, key)
      }
    } else if (o.type === 'user') {
      const c = o.message?.content
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type === 'tool_result') {
            r.resolved.add(b.tool_use_id)
            const n = names.get(b.tool_use_id)
            const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')
            if (b.is_error) {
              r.toolErr++
              if (n === 'StructuredOutput') r.structuredFail++
              if (WRITE_TOOLS.has(n)) r.writeDenied++
              if (/permission|denied|allowlist|not allowed|approv/i.test(txt)) r.permission = true
              if (/\b401\b|unauthoriz|authentication failed/i.test(txt)) r.auth = true
            } else if (WRITE_TOOLS.has(n)) r.wroteOk++
          } else if (b.type === 'text' && !r.firstText) {
            r.firstText = String(b.text || '').slice(0, 400)
          }
        }
      } else if (typeof c === 'string' && !r.firstText) {
        r.firstText = c.slice(0, 400)
      }
      if (!r.schedName && r.firstText) {
        const m = r.firstText.match(/<scheduled-task name="([^"]+)"/)
        if (m) r.schedName = m[1]
      }
    }
  }
  return r
}

// Ordered, because the naive version of each of these is wrong in a way that
// changes the headline. See README.
function terminalState(r) {
  if (r.lastStop === 'end_turn') return 'completed_prose'
  if (r.lastStop === 'tool_use' && r.lastToolId) {
    const resolved = r.resolved.has(r.lastToolId)
    if (RETURN_SET.has(r.lastTool) && resolved) return 'completed_structured'
    if (!resolved) return 'abandoned_mid_tool'
    return 'truncated'
  }
  if (r.lastStop === 'stop_sequence') return 'infra_halt'
  if (!r.lastStop && r.tools === 0) return 'zombie'
  return 'unknown'
}

// Tri-state on purpose. Without a filesystem probe the server cannot witness
// delivery, so `wrote_ok` is a tool-result observation and is never called
// DELIVERED. UNVERIFIED is the default and is never alarmed on: a write into a
// container is exactly the case a probe would get wrong.
function deliveryState(r) {
  if (r.writeDenied > 0) return 'denied'
  if (r.wroteOk > 0) return 'wrote_ok'
  if (r.intentWrite > 0) return 'unverified'
  return 'no_intent'
}

export async function collectRuns({ since = null } = {}) {
  const runs = []
  let projects = []
  try { projects = readdirSync(PROJECTS) } catch { return { runs: [], root: PROJECTS } }
  for (const proj of projects) {
    const dir = join(PROJECTS, proj)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    for (const file of walk(dir)) {
      const isSub = /\/subagents\//.test(file)
      const depth = file.slice(dir.length + 1).split('/').length - 1
      if (!isSub && depth !== 0) continue
      let s
      try { s = await scanRun(file) } catch { continue }
      if (!s.started) continue
      if (since && Date.parse(s.started) < since) continue
      const kind = isSub ? 'subagent' : s.schedName ? 'scheduled' : 'human'
      const agentMs = s.agentEnded ? Date.parse(s.agentEnded) - Date.parse(s.started) : 0
      runs.push({
        file, kind,
        repo: proj.replace(/^-Users-[^-]+-/, '').split('--claude-worktrees-')[0],
        task: s.schedName ? slug(s.schedName) : null,
        family: isSub ? familyOf(s.firstText) : null,
        week: isoWeek(s.started), started: s.started,
        terminal: terminalState(s), delivery: deliveryState(s),
        errorClass: s.permission ? 'permission' : s.auth ? 'auth' : s.toolErr ? 'tool_error' : 'none',
        out: s.out, cread: s.cread, ccreate: s.ccreate, cin: s.cin,
        tools: s.tools, toolErr: s.toolErr, loops: s.loops,
        structured: s.structured, structuredFail: s.structuredFail,
        intentWrite: s.intentWrite, wroteOk: s.wroteOk, writeDenied: s.writeDenied,
        agentMin: Math.round(agentMs / 60000),
        model: [...s.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
        topTools: [...s.toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, c]) => ({ n, c })),
      })
    }
  }
  runs.sort((a, b) => a.started.localeCompare(b.started))
  return { runs, root: PROJECTS }
}

// ---------------------------------------------------------------- aggregate

const sum = (a, f) => a.reduce((n, x) => n + f(x), 0)
const by = (a, k) => {
  const m = new Map()
  for (const x of a) {
    const v = x[k]
    if (v === null || v === undefined) continue
    if (!m.has(v)) m.set(v, [])
    m.get(v).push(x)
  }
  return m
}

export function ledger(runs) {
  const auto = runs.filter((r) => r.kind !== 'human')
  const tasks = [...by(runs.filter((r) => r.task), 'task').entries()].map(([task, a]) => {
    const delivered = a.filter((r) => r.delivery === 'wrote_ok').length
    const denied = a.filter((r) => r.delivery === 'denied').length
    return {
      task, runs: a.length, delivered, denied,
      unverified: a.filter((r) => r.delivery === 'unverified').length,
      noIntent: a.filter((r) => r.delivery === 'no_intent').length,
      out: sum(a, (r) => r.out), cread: sum(a, (r) => r.cread),
      lastRun: a[a.length - 1].started.slice(0, 10),
      series: a.map((r) => r.out),
      // The honest form of a zero denominator is a refusal plus both numbers.
      cpdo: delivered ? sum(a, (r) => r.out) / delivered : null,
      permission: a.filter((r) => r.errorClass === 'permission').length,
      // Same announced next step every run, and nothing shipped.
      stalled: delivered === 0 && a.length >= 3,
    }
  }).sort((x, y) => y.runs - x.runs)

  const families = [...by(runs.filter((r) => r.family), 'family').entries()].map(([family, a]) => ({
    family, runs: a.length,
    creadPerRun: Math.round(sum(a, (r) => r.cread) / a.length),
    outPerRun: Math.round(sum(a, (r) => r.out) / a.length),
    structured: sum(a, (r) => r.structured), structuredFail: sum(a, (r) => r.structuredFail),
    readers: a.filter((r) => r.intentWrite === 0 && r.tools > 5).length,
    zombie: a.filter((r) => r.terminal === 'zombie').length,
  })).sort((x, y) => y.runs - x.runs)

  const terminal = [...by(runs, 'terminal').entries()].map(([k, a]) => [k, a.length]).sort((x, y) => y[1] - x[1])
  const kinds = [...by(runs, 'kind').entries()].map(([k, a]) => [k, a.length])

  return {
    generated: new Date().toISOString().slice(0, 16).replace('T', ' '),
    totals: {
      runs: runs.length,
      ...Object.fromEntries(kinds),
      out: sum(runs, (r) => r.out), cread: sum(runs, (r) => r.cread),
      ccreate: sum(runs, (r) => r.ccreate), cin: sum(runs, (r) => r.cin),
      toolErr: sum(runs, (r) => r.toolErr), loops: sum(runs, (r) => r.loops),
    },
    terminal, tasks, families,
    autonomous: {
      runs: auto.length,
      delivered: auto.filter((r) => r.delivery === 'wrote_ok').length,
      denied: auto.filter((r) => r.delivery === 'denied').length,
      permission: auto.filter((r) => r.errorClass === 'permission').length,
      zombie: auto.filter((r) => r.terminal === 'zombie').length,
    },
    caveats: [
      'wrote_ok is a tool-result observation, not witnessed delivery — no filesystem probe runs.',
      'Subagent families come from a first-message heuristic, so the boundaries are approximate.',
      `RETURN_SET is hand-maintained (${[...RETURN_SET].join(', ')}). A run ending on one of these succeeded; treating "ended mid-tool-call" as failure would misclassify most of a healthy fleet.`,
      'agentMin measures the last assistant record, not the last record — a reopened session is not agent runtime.',
    ],
  }
}

// ---------------------------------------------------------------- cli

const fmt = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))
const pct = (n, d) => (d ? Math.round((n / d) * 100) + '%' : '—')

function renderLedger(L) {
  const t = L.totals, a = L.autonomous
  const out = []
  out.push(`runs        ${t.runs}   human ${t.human || 0} · scheduled ${t.scheduled || 0} · subagent ${t.subagent || 0}`)
  out.push(`tokens      ${fmt(t.out)} out · ${fmt(t.cread)} cache-read · ${fmt(t.ccreate)} cache-create`)
  out.push(`autonomous  ${a.runs} runs · ${a.delivered} wrote a file · ${a.denied} denied · ${a.zombie} zombie`)
  out.push('')
  out.push('terminal state')
  for (const [k, n] of L.terminal) out.push(`  ${String(n).padStart(5)}  ${k}`)
  if (L.tasks.length) {
    out.push('')
    out.push('recurring tasks')
    out.push('  runs  wrote  denied  output   cost/delivered   task')
    for (const x of L.tasks) {
      const cp = x.cpdo === null ? `undefined (${x.runs} runs, ${fmt(x.out)} out, 0 delivered)` : fmt(Math.round(x.cpdo))
      out.push(`  ${String(x.runs).padStart(4)}  ${String(x.delivered).padStart(5)}  ${String(x.denied).padStart(6)}  ${fmt(x.out).padStart(6)}   ${cp.padEnd(16)} ${x.task}${x.stalled ? '   << STALLED' : ''}`)
    }
  }
  if (L.families.length) {
    out.push('')
    out.push('subagent families')
    out.push('  runs  cache-read/run  out/run  schema fail  readers  family')
    for (const f of L.families) {
      const sf = f.structured ? `${f.structuredFail}/${f.structured} (${pct(f.structuredFail, f.structured)})` : '—'
      out.push(`  ${String(f.runs).padStart(4)}  ${fmt(f.creadPerRun).padStart(14)}  ${fmt(f.outPerRun).padStart(7)}  ${sf.padEnd(11)}  ${String(f.readers).padStart(7)}  ${f.family}`)
    }
  }
  out.push('')
  out.push('caveats')
  for (const c of L.caveats) out.push(`  - ${c}`)
  return out.join('\n')
}

function renderCost(L) {
  const t = L.totals
  const total = t.out + t.cread + t.ccreate
  const out = []
  out.push('token composition')
  for (const [label, v] of [['cache-read', t.cread], ['cache-create', t.ccreate], ['output', t.out]]) {
    const w = Math.round((v / total) * 46)
    out.push(`  ${label.padEnd(13)} ${fmt(v).padStart(7)}  ${pct(v, total).padStart(5)}  ${'█'.repeat(Math.max(1, w))}`)
  }
  out.push('')
  out.push('  Output is what the model generated. Cache-read is context replayed to it on')
  out.push('  every turn — it appears in no per-session view and it is almost the whole bill.')
  if (L.families.length) {
    const worst = [...L.families].sort((x, y) => y.creadPerRun - x.creadPerRun)
    const best = worst[worst.length - 1]
    out.push('')
    out.push('cache-read per run, by agent family')
    for (const f of worst) {
      const ratio = best.creadPerRun ? (f.creadPerRun / best.creadPerRun).toFixed(1) : '—'
      out.push(`  ${f.family.padEnd(15)} ${fmt(f.creadPerRun).padStart(7)}/run  ${String(f.runs).padStart(4)} runs   ${ratio}× the leanest`)
    }
    out.push('')
    out.push(`  The spread between families is the actionable part: same harness, same model,`)
    out.push(`  different prompt. Narrowing the widest one is worth more than any prompt tweak.`)
  }
  out.push('')
  out.push('  No currency is shown. The rate card is not part of this snapshot, and a dollar')
  out.push('  figure derived from an assumed price is an assumption rendered as a fact.')
  return out.join('\n')
}

const isMain = process.argv[1] && process.argv[1].endsWith('runs.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const sinceArg = opt('--since')
  let since = null
  if (sinceArg) {
    const m = sinceArg.match(/^(\d+)([dwm])$/)
    since = m ? Date.now() - Number(m[1]) * { d: 864e5, w: 7 * 864e5, m: 30 * 864e5 }[m[2]] : Date.parse(sinceArg)
  }
  const { runs } = await collectRuns({ since })
  if (!runs.length) {
    console.error('no transcripts found')
    process.exit(1)
  }
  const L = ledger(runs)
  if (argv.includes('--json')) console.log(JSON.stringify({ ...L, runs }, null, 2))
  else if (argv.includes('--cost')) console.log(renderCost(L))
  else console.log(renderLedger(L))
}
