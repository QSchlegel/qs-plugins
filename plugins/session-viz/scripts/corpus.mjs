#!/usr/bin/env node
// Aggregates every session transcript on this machine into a trend model.
//
//   node corpus.mjs                    # text summary
//   node corpus.mjs --json > c.json    # full model
//   node corpus.mjs --project my-repo --since 30d
//
// extract.mjs answers "how did this session go". This answers "how am I going",
// which is a different question and needs different statistics: rates over time
// rather than one number, incident counts rather than averages, and — above all
// — an explicit account of what the numbers cannot support.
//
// Sizing note: the corpus is small. ~60 sessions / 600 MB parses in ~2s at
// 250 MB/s, so there is no cache and no worker pool here. Both would be dead
// weight guarding a two-second cost. Revisit past ~5 GB.
//
// Only depth-2 files (projects/<slug>/<uuid>.jsonl) are sessions. The far more
// numerous files nested under <uuid>/subagents/ are subagent transcripts and are
// counted by size only — they have no human turns to score.

import { readdirSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { extract, listSessions } from './extract.mjs'

const PROJECTS = join(homedir(), '.claude', 'projects')

// ---------------------------------------------------------------- friction sets

// `roundtrip` fires when no tools ran, which makes it collinear with tool-call
// count by construction. Any analysis that stratifies on workload has to drop it
// or it will "discover" that low-workload turns are frictional — a tautology.
// The remaining four are genuine rework, independent of how much work was done.
const REWORK = new Set(['repeated', 'interrupted', 'correction', 'drew-correction'])

const hasRework = (t) => t.friction.some((f) => REWORK.has(f))
const hasFriction = (t) => t.friction.length > 0

// Turns where no assistant record carried a model — the request was aborted
// before anything ran. They are ~30% rework by construction (that is what being
// aborted means), so folding them into a model's rate would punish whichever
// model happened to be selected when the user hit escape.
const NO_MODEL = '(no model ran)'

// ---------------------------------------------------------------- projects

// Claude Code puts worktrees at <repo>/.claude/worktrees/<name>, and each one
// gets its own transcript directory. Left alone, a repo worked on across five
// worktrees appears as five unrelated single-session "projects" — which both
// hides the repo that actually dominates the corpus and makes every per-project
// rate a sample of one branch.
const WORKTREE_SEP = '/.claude/worktrees/'

const repoRoot = (cwd) => String(cwd || '').split(WORKTREE_SEP)[0]

// The branch-ish worktree name, or null for the main checkout. Kept rather than
// discarded: within a repo, "which worktree" is the useful second axis.
const worktreeOf = (cwd) => {
  const i = String(cwd || '').indexOf(WORKTREE_SEP)
  return i === -1 ? null : cwd.slice(i + WORKTREE_SEP.length).split('/')[0]
}

const repoName = (cwd) => repoRoot(cwd).replace(/^.*\//, '')

// ---------------------------------------------------------------- helpers

const rate = (n, d) => (d ? +(n / d).toFixed(3) : 0)
const sum = (a, f) => a.reduce((n, x) => n + f(x), 0)
const mean = (a, f) => (a.length ? sum(a, f) / a.length : 0)

function median(v) {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function weekStart(iso) {
  const d = new Date(iso)
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10)
}

function parseSince(v) {
  if (!v) return null
  const rel = v.match(/^(\d+)([dwm])$/)
  if (rel) {
    const mult = { d: 864e5, w: 7 * 864e5, m: 30 * 864e5 }[rel[2]]
    return Date.now() - Number(rel[1]) * mult
  }
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

// Subagent transcripts live under <session-id>/subagents/**. Counted by stat
// only — walking them is ~230 MB of parsing for a number we use as one stat.
function subagentVolume(sessionFile) {
  const dir = sessionFile.replace(/\.jsonl$/, '')
  if (!existsSync(dir)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  const walk = (d) => {
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.jsonl')) {
        files++
        try {
          bytes += statSync(full).size
        } catch {}
      }
    }
  }
  walk(dir)
  return { files, bytes }
}

// ---------------------------------------------------------------- digests

function digest(s, meta) {
  const t = s.totals
  const tools = {}
  for (const turn of s.turns) for (const tc of turn.toolCalls) tools[tc.name] = (tools[tc.name] || 0) + tc.count
  return {
    // Drill-down fields. Kept per-session rather than recomputed in the renderer
    // so the JSON stays the single source of truth for both views.
    models: s.models,
    topTools: Object.entries(tools)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([name, count]) => ({ name, count })),
    frictionTags: s.turns
      .flatMap((x) => x.friction)
      .reduce((acc, f) => {
        acc[f] = (acc[f] || 0) + 1
        return acc
      }, {}),
    medianPromptChars: median(s.turns.map((x) => x.signals.chars)),
    craftTurns: s.turns.filter((x) => x.score.additions.length).length,
    sessionId: s.sessionId,
    project: s.cwd ? repoName(s.cwd) : s.project,
    worktree: worktreeOf(s.cwd),
    cwd: s.cwd,
    gitBranch: s.gitBranch,
    title: s.title,
    startedAt: s.startedAt,
    durationMs: s.durationMs,
    turns: t.humanTurns,
    toolCalls: t.toolCalls,
    tokens: t.tokens,
    frictionTurns: t.frictionTurns,
    repeats: t.repeats,
    corrections: t.corrections,
    interruptions: t.interruptions,
    compactions: t.compactions,
    subagents: meta.subagents.files,
    score: s.score.value,
    band: s.score.band,
    confidence: s.score.confidence,
    wastedTokens: s.score.wastedTokens,
    bytes: meta.bytes,
  }
}

// ---------------------------------------------------------------- timeline

// Weekly, not daily: at ~130 turns/week a daily bucket is mostly noise and empty
// days, and the eye reads a 10-point line far better than a 63-point one.
function buildTimeline(turns) {
  const buckets = new Map()
  for (const t of turns) {
    const k = weekStart(t.startedAt)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k).push(t)
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([week, a]) => ({
      week,
      turns: a.length,
      sessions: new Set(a.map((t) => t._session)).size,
      frictionRate: rate(a.filter(hasFriction).length, a.length),
      reworkRate: rate(a.filter(hasRework).length, a.length),
      craftRate: rate(a.filter((t) => t.score.additions.length).length, a.length),
      interruptions: a.filter((t) => t.friction.includes('interrupted')).length,
      repeats: a.filter((t) => t.derived.repeatOf !== null).length,
      outputTokens: sum(a, (t) => t.tokens.output),
      medianPromptChars: median(a.map((t) => t.signals.chars)),
      models: a.reduce((acc, t) => {
        const k = t.model || NO_MODEL
        acc[k] = (acc[k] || 0) + 1
        return acc
      }, {}),
    }))
}

// Direction over the whole span, measured by thirds. Halves are too coarse to
// distinguish "improving" from "one bad week at the start"; thirds still leave
// enough turns per slice to mean something at this corpus size.
// Floors, so a narrow --since window cannot produce a confident-sounding slope.
// Below these the honest output is "not measurable": at one week per side a
// single bad afternoon reads as a trend.
const MIN_TREND_WEEKS = 6 // guarantees at least two weeks in each third
const MIN_TREND_TURNS = 100 // per side

function buildTrend(timeline, turns) {
  if (timeline.length < MIN_TREND_WEEKS)
    return { measurable: false, why: `only ${timeline.length} active weeks in scope — a direction needs at least ${MIN_TREND_WEEKS}` }
  const cut = Math.floor(timeline.length / 3)
  const early = timeline.slice(0, cut)
  const late = timeline.slice(-cut)
  const earlyTurns = sum(early, (b) => b.turns)
  const lateTurns = sum(late, (b) => b.turns)
  if (earlyTurns < MIN_TREND_TURNS || lateTurns < MIN_TREND_TURNS)
    return {
      measurable: false,
      why: `too few turns at the ends to compare (${earlyTurns} early, ${lateTurns} late — needs ${MIN_TREND_TURNS} each)`,
    }
  const w = (slice, key) => {
    const n = sum(slice, (b) => b.turns)
    return n ? +(sum(slice, (b) => b[key] * b.turns) / n).toFixed(3) : 0
  }
  const metric = (key) => {
    const from = w(early, key)
    const to = w(late, key)
    return { from, to, delta: +(to - from).toFixed(3), turnsCompared: sum(early, (b) => b.turns) + sum(late, (b) => b.turns) }
  }
  const rework = metric('reworkRate')
  return {
    measurable: true,
    weeksCompared: cut,
    earlyWeeks: [early[0].week, early[early.length - 1].week],
    lateWeeks: [late[0].week, late[late.length - 1].week],
    frictionRate: metric('frictionRate'),
    reworkRate: rework,
    craftRate: metric('craftRate'),
    medianPromptChars: metric('medianPromptChars'),
    // Direction is called off rework, not total friction: `roundtrip` moves with
    // how tool-heavy the work happens to be, which is not a prompting change.
    direction: rework.delta <= -0.02 ? 'improving' : rework.delta >= 0.02 ? 'worsening' : 'flat',
    turnsTotal: turns.length,
  }
}

// ---------------------------------------------------------------- taxonomy

const TAG_LABEL = {
  repeated: 're-sent verbatim',
  interrupted: 'interrupted mid-flight',
  correction: 'was itself a correction',
  'drew-correction': 'drew a correction next turn',
  roundtrip: 'no tools ran, no question asked',
}

function buildTaxonomy(turns) {
  const out = {}
  for (const tag of Object.keys(TAG_LABEL)) {
    const hit = turns.filter((t) => t.friction.includes(tag))
    out[tag] = {
      label: TAG_LABEL[tag],
      count: hit.length,
      turnRate: rate(hit.length, turns.length),
      sessions: new Set(hit.map((t) => t._session)).size,
      outputTokens: sum(hit, (t) => t.tokens.output),
      isRework: REWORK.has(tag),
    }
  }
  return out
}

function buildForm(turns) {
  const keys = ['hasAcceptanceCriteria', 'hasFileRef', 'hasCodeBlock', 'terse', 'isQuestion', 'hasUrl']
  const out = {}
  for (const k of keys) {
    const hit = turns.filter((t) => t.signals[k])
    out[k] = { count: hit.length, turnRate: rate(hit.length, turns.length) }
  }
  return out
}

// ---------------------------------------------------------------- signals

// Workload strata. Every interesting prompt signal is confounded with how hard
// the work was — long prompts naming files are sent for hard tasks, "yes" is
// sent for easy ones — so an unstratified rate compares difficulty, not craft.
const STRATA = [
  { key: 'none', label: '0 tools', lo: 0, hi: 1 },
  { key: 'light', label: '1-3 tools', lo: 1, hi: 4 },
  { key: 'medium', label: '4-11 tools', lo: 4, hi: 12 },
  { key: 'heavy', label: '12+ tools', lo: 12, hi: Infinity },
]

const MIN_ARM = 25 // per-arm n below which a stratum says nothing
const MIN_EFFECT = 0.03 // 3 percentage points; below this it is noise at our n
const MIN_EVENTS = 8 // rework incidents in the treated arm — a rate built on 4 is not a rate
const MIN_Z = 2 // ~95%, two-tailed

// Two-proportion z-test. Necessary because an n-floor alone cannot gate a rare
// outcome: with rework at ~5%, a 25-turn arm expects one incident, so a stratum
// can clear MIN_ARM and still be four coin flips. Without this, the corpus
// reports "stating acceptance criteria causes more rework" off 4 events in 29
// turns — a false positive that would advise the user to stop doing the one
// thing the scorer rewards.
function ztest(onEvents, onN, offEvents, offN) {
  if (!onN || !offN) return 0
  const p1 = onEvents / onN
  const p2 = offEvents / offN
  const p = (onEvents + offEvents) / (onN + offN)
  const se = Math.sqrt(p * (1 - p) * (1 / onN + 1 / offN))
  return se ? +((p1 - p2) / se).toFixed(2) : 0
}

// Compares one prompt signal against the rework rate, within workload strata.
//
// The gate matters more than the number. At a ~12% base rate over ~1300 turns,
// most of these comparisons cannot reach significance, and an ungated table
// invites exactly the wrong conclusion — the raw numbers in this corpus say
// naming a file *doubles* friction, which is difficulty leaking through, not
// advice. So each signal carries a verdict, and `rawMisleading` marks the cases
// where controlling for workload flips or erases the naive direction.
function analyseSignal(turns, key) {
  const arm = (a) => ({ n: a.length, events: a.filter(hasRework).length, rework: rate(a.filter(hasRework).length, a.length) })
  const raw = { on: arm(turns.filter((t) => t.signals[key])), off: arm(turns.filter((t) => !t.signals[key])) }
  raw.delta = +(raw.on.rework - raw.off.rework).toFixed(3)

  const strata = STRATA.map((s) => {
    const pool = turns.filter((t) => {
      const n = t.toolCallCount || 0
      return n >= s.lo && n < s.hi
    })
    const on = arm(pool.filter((t) => t.signals[key]))
    const off = arm(pool.filter((t) => !t.signals[key]))
    return {
      key: s.key,
      label: s.label,
      on,
      off,
      delta: +(on.rework - off.rework).toFixed(3),
      // The 0-tool stratum is excluded from the verdict, not hidden: it is where
      // roundtrip lives, and it is dominated by turns where nothing happened.
      counts: s.key !== 'none' && on.n >= MIN_ARM && off.n >= MIN_ARM,
    }
  })

  const usable = strata.filter((s) => s.counts)
  const consistent = usable.length >= 2 && usable.every((s) => Math.sign(s.delta) === Math.sign(usable[0].delta))
  const pooled = usable.length
    ? +(sum(usable, (s) => s.delta * (s.on.n + s.off.n)) / sum(usable, (s) => s.on.n + s.off.n)).toFixed(3)
    : 0

  // Pooling naively across strata would re-admit the confounding the strata were
  // built to remove, so significance is only ever read alongside the
  // direction-consistency requirement above — never on its own.
  const onEvents = sum(usable, (s) => s.on.events)
  const onN = sum(usable, (s) => s.on.n)
  const offEvents = sum(usable, (s) => s.off.events)
  const offN = sum(usable, (s) => s.off.n)
  const z = ztest(onEvents, onN, offEvents, offN)

  const reliable = consistent && Math.abs(pooled) >= MIN_EFFECT && onEvents >= MIN_EVENTS && Math.abs(z) >= MIN_Z

  let verdict
  if (usable.length < 2) verdict = `too few turns to test — needs ${MIN_ARM}+ on each side in at least two workload strata`
  else if (!consistent) verdict = 'effect changes direction between workload strata — not a real effect'
  else if (onEvents < MIN_EVENTS) verdict = `only ${onEvents} rework incidents to build the rate on — too few to distinguish from chance`
  else if (Math.abs(pooled) < MIN_EFFECT) verdict = 'no effect large enough to act on once workload is controlled'
  else if (Math.abs(z) < MIN_Z) verdict = `not significant (z=${z}) — the gap is within what this many turns would produce by chance`
  else verdict = pooled < 0 ? 'less rework, holding workload constant' : 'more rework, holding workload constant'

  return {
    signal: key,
    raw,
    strata,
    pooledDelta: pooled,
    strataUsed: usable.length,
    onEvents,
    z,
    reliable,
    verdict,
    // Flags the trap: raw says one thing, stratified says another or nothing.
    rawMisleading: Math.abs(raw.delta) >= MIN_EFFECT && (!reliable || Math.sign(raw.delta) !== Math.sign(pooled)),
  }
}

// ---------------------------------------------------------------- models

const MIN_MODEL_TURNS = 40 // below this a model is listed but never compared
const MIN_WEEK_SHARE = 20 // turns a model needs in a week for that week to count as shared
const MIN_PAIR_ARM = 80 // turns per side, pooled over shared weeks

// Per-model rollup. Deliberately does NOT rank models: the comparison lives in
// comparePair below, because a bare table sorted by rework rate is read as a
// leaderboard even when the rates come from different months.
function modelRollup(turns, sessions) {
  const by = new Map()
  for (const t of turns) {
    const k = t.model || NO_MODEL
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(t)
  }
  // Two different dates, because they answer different questions. A turn is
  // attributed to the model that did most of its work, so a model can appear in
  // a session weeks before it first *leads* a turn — quoting the led date as
  // "first seen" would misstate when a release actually landed.
  const appeared = new Map()
  for (const s of sessions) {
    for (const name of Object.keys(s.models || {})) {
      const prev = appeared.get(name)
      if (!prev || s.startedAt < prev) appeared.set(name, s.startedAt)
    }
  }
  return [...by.entries()]
    .map(([name, a]) => ({
      name,
      turns: a.length,
      sessions: new Set(a.map((t) => t._session)).size,
      firstAppeared: appeared.get(name) || null,
      firstLed: a.reduce((m, t) => (m && m < t.startedAt ? m : t.startedAt), null),
      lastLed: a.reduce((m, t) => (m && m > t.startedAt ? m : t.startedAt), null),
      weeks: new Set(a.map((t) => weekStart(t.startedAt))).size,
      reworkRate: rate(a.filter(hasRework).length, a.length),
      reworkEvents: a.filter(hasRework).length,
      interruptRate: rate(a.filter((t) => t.friction.includes('interrupted')).length, a.length),
      toolsPerTurn: +mean(a, (t) => t.toolCallCount || 0).toFixed(1),
      outputPerTurn: Math.round(mean(a, (t) => t.tokens.output)),
      medianDurationMs: median(a.map((t) => t.durationMs)),
      outputTokens: sum(a, (t) => t.tokens.output),
      comparable: name !== NO_MODEL && a.length >= MIN_MODEL_TURNS,
    }))
    .sort((a, b) => b.turns - a.turns)
}

// A model release is confounded with time in the worst possible way: you adopt
// the new one and stop using the old one, so "new model, less rework" and "you
// got better at this over the same weeks" are the same data. The only way to
// separate them is to compare the two models *within the weeks they both ran at
// volume* — and when there are no such weeks, to say so instead of ranking.
function comparePair(turns, a, b) {
  const weeksOf = (name) => {
    const m = new Map()
    for (const t of turns) {
      if ((t.model || NO_MODEL) !== name) continue
      const w = weekStart(t.startedAt)
      m.set(w, (m.get(w) || 0) + 1)
    }
    return m
  }
  const wa = weeksOf(a)
  const wb = weeksOf(b)
  const shared = [...wa.keys()].filter((w) => wa.get(w) >= MIN_WEEK_SHARE && (wb.get(w) || 0) >= MIN_WEEK_SHARE).sort()

  const pick = (name) => turns.filter((t) => (t.model || NO_MODEL) === name && shared.includes(weekStart(t.startedAt)))
  const ta = pick(a)
  const tb = pick(b)
  const ea = ta.filter(hasRework).length
  const eb = tb.filter(hasRework).length

  const base = { a, b, sharedWeeks: shared, aTurns: ta.length, bTurns: tb.length }

  if (!shared.length)
    return {
      ...base,
      comparable: false,
      why: `never ran at volume in the same week — ${a} and ${b} do not overlap, so any difference between them is indistinguishable from the change over time`,
    }
  if (ta.length < MIN_PAIR_ARM || tb.length < MIN_PAIR_ARM)
    return {
      ...base,
      comparable: false,
      why: `only ${ta.length} vs ${tb.length} turns in the ${shared.length} shared week(s) — needs ${MIN_PAIR_ARM} each`,
    }

  const ra = rate(ea, ta.length)
  const rb = rate(eb, tb.length)
  const z = ztest(ea, ta.length, eb, tb.length)
  const significant = Math.abs(z) >= MIN_Z
  return {
    ...base,
    comparable: true,
    aRework: ra,
    bRework: rb,
    delta: +(ra - rb).toFixed(3),
    aEvents: ea,
    bEvents: eb,
    z,
    significant,
    why: significant
      ? `${ra < rb ? a : b} had less rework in the ${shared.length} weeks both ran (z=${z})`
      : `no separable difference across the ${shared.length} shared week(s) (z=${z}) — ${ea + eb} rework incidents between them is too few to call`,
  }
}

function buildModels(turns, sessions) {
  const rollup = modelRollup(turns, sessions)
  const names = rollup.filter((m) => m.comparable).map((m) => m.name)
  const pairs = []
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) pairs.push(comparePair(turns, names[i], names[j]))
  }
  // Ordered by adoption so the HTML can narrate the release timeline directly.
  const adoption = rollup
    .filter((m) => m.name !== NO_MODEL)
    .slice()
    .sort((a, b) => String(a.firstAppeared).localeCompare(String(b.firstAppeared)))
    .map((m) => ({
      name: m.name,
      firstAppeared: m.firstAppeared,
      firstLed: m.firstLed,
      lastLed: m.lastLed,
      turns: m.turns,
      weeks: m.weeks,
    }))
  return { rollup, pairs, adoption, anyComparable: pairs.some((p) => p.comparable) }
}

// ---------------------------------------------------------------- knowledge graph

// Topics come from tool-call inputs — packages imported, CLIs run, stack files
// touched, skills and MCP servers used — never from prompt wording. What a
// session *did* is unambiguous; what it was *called* is not.
const TOPIC_KINDS = [
  { key: 'packages', kind: 'package' },
  { key: 'tools', kind: 'tool' },
  { key: 'stack', kind: 'stack' },
  { key: 'skills', kind: 'skill' },
  { key: 'mcp', kind: 'mcp' },
]

// A topic earns a place only if it bridges. Present in one repo, it describes
// that repo and connects nothing; present in nearly all of them, it describes
// the toolchain rather than any relationship — `git` and `node` link every pair
// equally, which is the same as linking none. Both ends are cut, and what got
// cut is reported rather than quietly dropped.
const MIN_TOPIC_REPOS = 2
// Half, not most. A tool in half your repositories is your default toolchain —
// `npm` and `package.json` linked ten of sixteen here and drowned every real
// signal, because "both are Node projects" is not a relationship worth drawing.
const UNIVERSAL_SHARE = 0.5

function buildGraph(byRepo) {
  const repos = [...byRepo.entries()].map(([cwd, group]) => ({
    cwd,
    name: cwd.replace(/^.*\//, ''),
    turns: group.reduce((n, s) => n + s.turns.length, 0),
    artifacts: group.reduce((acc, s) => {
      for (const { key } of TOPIC_KINDS) {
        acc[key] ||= {}
        for (const [a, n] of Object.entries(s.artifacts?.[key] || {})) acc[key][a] = (acc[key][a] || 0) + n
      }
      return acc
    }, {}),
  }))
  const repoCount = repos.length
  const universalAt = Math.max(MIN_TOPIC_REPOS + 1, Math.ceil(repoCount * UNIVERSAL_SHARE))

  // topic id -> {kind, repos: Map<repoName, weight>}
  const topics = new Map()
  for (const r of repos) {
    for (const { key, kind } of TOPIC_KINDS) {
      for (const [name, n] of Object.entries(r.artifacts[key] || {})) {
        const id = `${kind}:${name}`
        if (!topics.has(id)) topics.set(id, { id, kind, label: name, repos: new Map() })
        topics.get(id).repos.set(r.name, n)
      }
    }
  }

  const universal = []
  const singletons = []
  const kept = []
  for (const t of topics.values()) {
    if (t.repos.size < MIN_TOPIC_REPOS) singletons.push(t.label)
    else if (t.repos.size >= universalAt) universal.push({ label: t.label, kind: t.kind, repos: t.repos.size })
    else kept.push(t)
  }
  kept.sort((a, b) => b.repos.size - a.repos.size || a.label.localeCompare(b.label))

  // A repo with no bridging topic has nothing to draw. Left in, it is a free
  // particle: no edge pulls it, repulsion pushes it to infinity, and fitting the
  // viewport to its position crushes the connected component into a corner. It
  // is reported by name under `isolated` instead.
  const connected = new Set()
  for (const t of kept) for (const repo of t.repos.keys()) connected.add(repo)

  const nodes = [
    ...repos
      .filter((r) => connected.has(r.name))
      .map((r) => ({ id: `repo:${r.name}`, kind: 'repo', label: r.name, turns: r.turns, degree: 0 })),
    ...kept.map((t) => ({ id: t.id, kind: t.kind, label: t.label, degree: t.repos.size })),
  ]
  const edges = []
  for (const t of kept) {
    for (const [repo, weight] of t.repos) edges.push({ source: `repo:${repo}`, target: t.id, weight })
  }
  const degree = new Map()
  for (const e of edges) {
    degree.set(e.source, (degree.get(e.source) || 0) + 1)
    degree.set(e.target, (degree.get(e.target) || 0) + 1)
  }
  for (const n of nodes) n.degree = degree.get(n.id) || 0

  // Relatedness is Jaccard weighted by inverse document frequency. Unweighted,
  // every pair of Node repos scores highly on the handful of topics they all
  // have, and the ranking becomes a list of which repos are biggest. Weighting
  // by log(repos / topic frequency) makes a shared `@prisma/client` (4 repos)
  // count roughly three times a shared `docker` (7), which is the actual
  // difference in how much the two imply about transferable knowledge.
  const idf = new Map(kept.map((t) => [t.id, Math.log(repoCount / t.repos.size)]))
  const topicsOf = new Map(repos.map((r) => [r.name, new Set()]))
  for (const t of kept) for (const repo of t.repos.keys()) topicsOf.get(repo).add(t.id)
  const wsum = (ids) => [...ids].reduce((n, id) => n + (idf.get(id) || 0), 0)

  const related = []
  for (let i = 0; i < repos.length; i++) {
    for (let j = i + 1; j < repos.length; j++) {
      const A = topicsOf.get(repos[i].name)
      const B = topicsOf.get(repos[j].name)
      if (!A.size || !B.size) continue
      const shared = [...A].filter((x) => B.has(x))
      if (!shared.length) continue
      const union = wsum(new Set([...A, ...B]))
      related.push({
        a: repos[i].name,
        b: repos[j].name,
        // Most distinctive first, so the list leads with what the pair actually
        // has in common rather than with whatever is alphabetically first.
        shared: shared
          .slice()
          .sort((x, y) => (idf.get(y) || 0) - (idf.get(x) || 0))
          .map((id) => id.split(':').slice(1).join(':')),
        score: union ? +(wsum(shared) / union).toFixed(3) : 0,
      })
    }
  }
  related.sort((x, y) => y.score - x.score || y.shared.length - x.shared.length)

  return {
    nodes,
    edges,
    layout: layoutGraph(nodes, edges),
    related: related.slice(0, 25),
    bridges: kept.slice(0, 20).map((t) => ({ topic: t.label, kind: t.kind, repos: [...t.repos.keys()] })),
    gate: {
      minRepos: MIN_TOPIC_REPOS,
      universalAt,
      repoCount,
      kept: kept.length,
      droppedSingleton: singletons.length,
      droppedUniversal: universal.sort((a, b) => b.repos - a.repos),
    },
    isolated: repos.filter((r) => !connected.has(r.name)).map((r) => r.name),
  }
}

// Force-directed layout, computed here rather than in the browser so the page
// stays static and the same corpus always draws the same picture. Seeding on a
// circle by index keeps it free of randomness — Math.random would make every
// regeneration a different graph and every diff meaningless.
function layoutGraph(nodes, edges, { width = 1000, height = 620, iterations = 400 } = {}) {
  const n = nodes.length
  if (!n) return { width, height, positions: {} }
  const pos = nodes.map((_, i) => {
    const a = (i / n) * Math.PI * 2
    return { x: width / 2 + Math.cos(a) * width * 0.32, y: height / 2 + Math.sin(a) * height * 0.32 }
  })
  const index = new Map(nodes.map((nd, i) => [nd.id, i]))
  const k = Math.sqrt((width * height) / n) * 0.55
  // Hubs should not be flung to the rim by sheer edge count, so attraction is
  // damped by degree; repos additionally pull toward the middle.
  const deg = nodes.map((nd) => Math.max(1, nd.degree))

  for (let it = 0; it < iterations; it++) {
    const temp = (1 - it / iterations) * (width * 0.06) + 0.5
    const dx = new Array(n).fill(0)
    const dy = new Array(n).fill(0)

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let ex = pos[i].x - pos[j].x
        let ey = pos[i].y - pos[j].y
        let d2 = ex * ex + ey * ey
        if (d2 < 0.01) {
          ex = (i % 7) - 3 + 0.5
          ey = (j % 5) - 2 + 0.5
          d2 = ex * ex + ey * ey
        }
        const d = Math.sqrt(d2)
        const f = (k * k) / d
        dx[i] += (ex / d) * f
        dy[i] += (ey / d) * f
        dx[j] -= (ex / d) * f
        dy[j] -= (ey / d) * f
      }
    }

    for (const e of edges) {
      const i = index.get(e.source)
      const j = index.get(e.target)
      if (i === undefined || j === undefined) continue
      const ex = pos[i].x - pos[j].x
      const ey = pos[i].y - pos[j].y
      const d = Math.sqrt(ex * ex + ey * ey) || 0.01
      const f = (d * d) / k / Math.sqrt(Math.min(deg[i], deg[j]))
      dx[i] -= (ex / d) * f
      dy[i] += -(ey / d) * f
      dx[j] += (ex / d) * f
      dy[j] += (ey / d) * f
    }

    for (let i = 0; i < n; i++) {
      dx[i] += (width / 2 - pos[i].x) * 0.012
      dy[i] += (height / 2 - pos[i].y) * 0.012
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1
      const step = Math.min(d, temp)
      pos[i].x += (dx[i] / d) * step
      pos[i].y += (dy[i] / d) * step
    }
  }

  // Fit to the viewport with room for labels.
  const pad = 56
  const xs = pos.map((p) => p.x)
  const ys = pos.map((p) => p.y)
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const sx = (width - pad * 2) / Math.max(1, maxX - minX)
  const sy = (height - pad * 2) / Math.max(1, maxY - minY)
  const positions = {}
  nodes.forEach((nd, i) => {
    positions[nd.id] = {
      x: +(pad + (pos[i].x - minX) * sx).toFixed(1),
      y: +(pad + (pos[i].y - minY) * sy).toFixed(1),
    }
  })
  return { width, height, positions }
}

// ---------------------------------------------------------------- exemplars

const clip = (s, n = 260) => {
  const one = String(s || '').replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n) + '…' : one
}

// The single most useful artefact in the corpus: a prompt that did not land,
// paired with the prompt the user actually sent next. That pair is direct
// evidence of what a rewrite looks like, which no aggregate rate can give.
function buildExemplars(sessions, turns) {
  const repeats = []
  const corrections = []
  for (const s of sessions) {
    for (const t of s.turns) {
      if (t.derived.repeatOf !== null) {
        const orig = s.turns.find((x) => x.index === t.derived.repeatOf)
        repeats.push({
          sessionId: s.sessionId,
          project: repoName(s.cwd),
          at: t.startedAt,
          firstTurn: t.derived.repeatOf,
          repeatTurn: t.index,
          text: clip(t.text),
          firstToolCalls: orig?.toolCallCount ?? null,
        })
      }
      if (t.signals.isCorrection && t.index > 0) {
        const prev = s.turns.find((x) => x.index === t.index - 1)
        if (prev) {
          corrections.push({
            sessionId: s.sessionId,
            project: repoName(s.cwd),
            at: t.startedAt,
            drewIt: { turn: prev.index, text: clip(prev.text, 200), toolCalls: prev.toolCallCount, outputTokens: prev.tokens.output },
            correction: { turn: t.index, text: clip(t.text, 200) },
          })
        }
      }
    }
  }

  // "Worst" is cost-weighted on purpose here, unlike the session score: for
  // exemplars we want the failures that were expensive enough to be worth
  // reading, not the cheapest ones that merely scored badly.
  const worst = turns
    .filter(hasRework)
    .sort((a, b) => b.tokens.output - a.tokens.output)
    .slice(0, 10)
    .map((t) => ({
      sessionId: t._session,
      project: t._project,
      at: t.startedAt,
      turn: t.index,
      score: t.score.value,
      friction: t.friction,
      toolCalls: t.toolCallCount,
      outputTokens: t.tokens.output,
      durationMs: t.durationMs,
      text: clip(t.text),
    }))

  return {
    repeats: repeats.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12),
    corrections: corrections.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10),
    worst,
  }
}

// Every rework turn, uncapped and compact. At a ~6% rate this is ~80 rows for a
// 1300-turn corpus, cheap enough to carry whole — and carrying it whole is what
// lets the project and session drill-downs show their own incidents without the
// model re-deriving them or the JSON duplicating turn text per grouping.
function buildIncidents(turns) {
  return turns
    .filter(hasRework)
    .map((t) => ({
      sessionId: t._session,
      project: t._project,
      at: t.startedAt,
      turn: t.index,
      tags: t.friction.filter((f) => REWORK.has(f)),
      score: t.score.value,
      model: t.model || NO_MODEL,
      toolCalls: t.toolCallCount,
      outputTokens: t.tokens.output,
      durationMs: t.durationMs,
      text: clip(t.text, 160),
    }))
    .sort((a, b) => b.outputTokens - a.outputTokens)
}

// ---------------------------------------------------------------- caveats

// Generated, not written: the point is that the caveats track the actual corpus
// rather than being boilerplate someone stops reading.
function buildCaveats(model) {
  const c = []
  const { meta, signals, sessions, trend, models } = model
  if (meta.excluded.noHumanTurns)
    c.push(
      `${meta.excluded.noHumanTurns} of ${meta.excluded.transcriptsFound} transcripts contain no human turns — almost always scheduled-task runs — and are excluded entirely. They still consumed tokens; nothing here accounts for them.`
    )

  // The single most misreadable number in the report. State it before anyone
  // reaches the model table and reads it as a benchmark.
  const uncomparable = models.pairs.filter((p) => !p.comparable && !p.sharedWeeks.length)
  if (uncomparable.length)
    c.push(
      `${uncomparable.map((p) => `${p.a} vs ${p.b}`).join('; ')} never ran at volume in the same week. Their rework rates come from different months, and rework was already falling for other reasons, so the difference between them cannot be attributed to the model.`
    )
  if (models.rollup.some((m) => !m.comparable && m.name !== NO_MODEL))
    c.push(
      `${models.rollup
        .filter((m) => !m.comparable && m.name !== NO_MODEL)
        .map((m) => `${m.name} (${m.turns} turns)`)
        .join(', ')} — too few turns to compare against anything; listed for completeness only.`
    )
  const noModel = models.rollup.find((m) => m.name === NO_MODEL)
  if (noModel)
    c.push(
      `${noModel.turns} turns had no model record because the request was aborted before anything ran. They are excluded from every per-model rate; folding them in would blame whichever model happened to be selected.`
    )
  if (meta.turnCount < 300) c.push(`Only ${meta.turnCount} human turns in scope — rates below ~5% are single incidents, not patterns.`)
  const lowConf = sessions.filter((s) => s.confidence !== 'high').length
  if (lowConf)
    c.push(
      `${lowConf} of ${sessions.length} sessions are under 20 turns, so their individual scores are low-confidence. Corpus rates pool them and are sounder than any one of them.`
    )
  const misled = signals.filter((s) => s.rawMisleading).map((s) => s.signal)
  if (misled.length)
    c.push(
      `Raw correlations for ${misled.join(', ')} point the wrong way: hard tasks attract long, file-naming prompts, so the naive rate measures difficulty, not prompting. Only the stratified verdict is usable.`
    )
  if (signals.every((s) => !s.reliable))
    c.push('No prompt-form signal survived the workload control. Nothing in this corpus supports advice of the form "phrase prompts like X".')
  if (trend.measurable && Math.abs(trend.reworkRate.delta) < 0.02)
    c.push('Rework rate is flat across the span — the trend line is not evidence of improvement either way.')
  // A verbatim repeat is read as "the first attempt did not land", which is
  // wrong for idempotent commands — "ship to preprod" four times is four
  // deploys, not four failures. Flag it when one phrase dominates.
  const byText = new Map()
  for (const r of model.exemplars.repeats) byText.set(r.text, (byText.get(r.text) || 0) + 1)
  const dominant = [...byText.entries()].filter(([, n]) => n >= 3)
  if (dominant.length)
    c.push(
      `${dominant.map(([t, n]) => `"${t.slice(0, 40)}" (×${n})`).join(', ')} — a phrase re-sent this often is usually a recurring command rather than a prompt that failed, so the repeat count overstates rework.`
    )
  const topProject = model.projects[0]
  if (topProject && topProject.turns / meta.turnCount > 0.25)
    c.push(
      `${topProject.name} is ${Math.round((topProject.turns / meta.turnCount) * 100)}% of all turns (${topProject.turns} across ${topProject.worktrees.length} worktree(s)), so corpus-wide rates lean heavily on one repository.`
    )
  const top = sessions.slice().sort((a, b) => b.turns - a.turns)[0]
  if (top && top.turns / meta.turnCount > 0.15)
    c.push(
      `One session (${top.sessionId.slice(0, 8)}, ${top.project}) is ${Math.round((top.turns / meta.turnCount) * 100)}% of all turns, so corpus rates partly describe that one session.`
    )
  return c
}

// ---------------------------------------------------------------- build

export async function buildCorpus({ projectFilter = null, since = null, limit = null } = {}) {
  let files = listSessions(projectFilter)
  if (limit) files = files.slice(0, Number(limit))

  const sessions = []
  const failures = []
  // Sessions with no human turns are almost all scheduled-task runs: real work,
  // real tokens, but nobody typed anything, so there is no prompting to analyse.
  // Excluded from every rate and counted here rather than vanishing.
  let noHumanTurns = 0
  let outOfWindow = 0
  for (const f of files) {
    try {
      const s = await extract(f.file)
      if (!s.turns.length) {
        noHumanTurns++
        continue
      }
      if (since && Date.parse(s.startedAt) < since) {
        outOfWindow++
        continue
      }
      s._meta = { bytes: f.size, subagents: subagentVolume(f.file) }
      sessions.push(s)
    } catch (e) {
      failures.push({ file: f.file, error: e.message })
    }
  }
  sessions.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)))

  // Flatten once, tagging provenance so every aggregate can point back.
  const turns = sessions.flatMap((s) =>
    s.turns.map((t) => ({ ...t, _session: s.sessionId, _project: repoName(s.cwd) || s.project }))
  )

  const digests = sessions.map((s) => digest(s, s._meta))
  const timeline = buildTimeline(turns)
  const trend = buildTrend(timeline, turns)

  // Grouped by repository, not by working directory — worktrees of one repo are
  // one project.
  const byProject = new Map()
  for (const s of sessions) {
    const k = s.cwd ? repoRoot(s.cwd) : s.project
    if (!byProject.has(k)) byProject.set(k, [])
    byProject.get(k).push(s)
  }
  const projects = [...byProject.entries()]
    .map(([cwd, group]) => {
      const ts = group.flatMap((s) => s.turns)
      const models = {}
      for (const s of group) for (const [m, n] of Object.entries(s.models)) models[m] = (models[m] || 0) + n
      const wt = new Map()
      for (const s of group) {
        const name = worktreeOf(s.cwd) || '(main checkout)'
        const prev = wt.get(name) || { name, sessions: 0, turns: 0, frictionTurns: 0 }
        prev.sessions++
        prev.turns += s.turns.length
        prev.frictionTurns += s.turns.filter(hasFriction).length
        wt.set(name, prev)
      }
      return {
        name: cwd.replace(/^.*\//, ''),
        cwd,
        worktrees: [...wt.values()].sort((a, b) => b.turns - a.turns),
        sessions: group.length,
        sessionIds: group.map((s) => s.sessionId),
        turns: ts.length,
        frictionRate: rate(ts.filter(hasFriction).length, ts.length),
        reworkRate: rate(ts.filter(hasRework).length, ts.length),
        craftRate: rate(ts.filter((t) => t.score.additions.length).length, ts.length),
        outputTokens: sum(group, (s) => s.totals.tokens.output),
        cacheReadTokens: sum(group, (s) => s.totals.tokens.cacheRead),
        toolCalls: sum(group, (s) => s.totals.toolCalls),
        subagents: sum(group, (s) => s._meta.subagents.files),
        repeats: sum(group, (s) => s.totals.repeats),
        interruptions: sum(group, (s) => s.totals.interruptions),
        corrections: sum(group, (s) => s.totals.corrections),
        wastedTokens: sum(group, (s) => s.score.wastedTokens),
        medianPromptChars: median(ts.map((t) => t.signals.chars)),
        firstSeen: group.reduce((m, s) => (m && m < s.startedAt ? m : s.startedAt), null),
        lastSeen: group.reduce((m, s) => (m && m > s.endedAt ? m : s.endedAt), null),
        models,
        meanScore: Math.round(mean(group, (s) => s.score.value || 0)),
      }
    })
    .sort((a, b) => b.turns - a.turns)

  const model = {
    meta: {
      generatedAt: new Date().toISOString(),
      sessionCount: sessions.length,
      turnCount: turns.length,
      projectCount: projects.length,
      span: {
        from: sessions[0]?.startedAt || null,
        to: sessions[sessions.length - 1]?.endedAt || null,
        days: sessions.length
          ? Math.max(1, Math.round((Date.parse(sessions[sessions.length - 1].endedAt) - Date.parse(sessions[0].startedAt)) / 864e5))
          : 0,
      },
      transcriptBytes: sum(sessions, (s) => s._meta.bytes),
      subagents: {
        files: sum(sessions, (s) => s._meta.subagents.files),
        bytes: sum(sessions, (s) => s._meta.subagents.bytes),
      },
      filter: { project: projectFilter, since: since ? new Date(since).toISOString() : null },
      excluded: { noHumanTurns, outOfWindow, transcriptsFound: files.length },
      failures,
    },
    totals: {
      tokens: sessions.reduce(
        (a, s) => {
          for (const k of ['input', 'output', 'cacheRead', 'cacheCreate']) a[k] += s.totals.tokens[k]
          return a
        },
        { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
      ),
      toolCalls: sum(sessions, (s) => s.totals.toolCalls),
      frictionTurns: turns.filter(hasFriction).length,
      reworkTurns: turns.filter(hasRework).length,
      interruptions: sum(sessions, (s) => s.totals.interruptions),
      repeats: sum(sessions, (s) => s.totals.repeats),
      corrections: sum(sessions, (s) => s.totals.corrections),
      compactions: sum(sessions, (s) => s.totals.compactions),
      wastedTokens: sum(turns.filter(hasFriction), (t) => t.tokens.output),
      // Sum of per-session first→last spans. NOT time spent working: a session
      // left open overnight contributes the whole night, which is why this
      // exceeds the corpus span. Reported for scale only.
      sessionSpanMs: sum(sessions, (s) => s.durationMs),
      frictionRate: rate(turns.filter(hasFriction).length, turns.length),
      reworkRate: rate(turns.filter(hasRework).length, turns.length),
      craftRate: rate(turns.filter((t) => t.score.additions.length).length, turns.length),
    },
    trend,
    timeline,
    taxonomy: buildTaxonomy(turns),
    form: buildForm(turns),
    signals: ['hasAcceptanceCriteria', 'hasFileRef', 'hasCodeBlock', 'terse'].map((k) => analyseSignal(turns, k)),
    models: buildModels(turns, sessions),
    graph: buildGraph(byProject),
    projects,
    sessions: digests,
    exemplars: buildExemplars(sessions, turns),
    incidents: buildIncidents(turns),
  }
  model.caveats = buildCaveats(model)
  return model
}

// ---------------------------------------------------------------- brief

// The full model grows linearly with sessions and incidents — 176 KB at 63
// sessions, and the renderer needs all of it. A reader does not: the aggregates
// are what carry the argument, and a capped sample of the long tails is enough
// to quote from. Every cap is declared in `truncated` rather than silently
// applied, so a reader can tell "there were 3" from "I was shown 3 of 77".
const BRIEF_PROJECTS = 20
const BRIEF_SESSIONS = 20
const BRIEF_INCIDENTS = 30

export function brief(m) {
  return {
    ...m,
    truncated: {
      note: 'Capped view for reading. The full model — every session, project and incident — is in the JSON passed to render-corpus.mjs.',
      projects: { shown: Math.min(BRIEF_PROJECTS, m.projects.length), of: m.projects.length, by: 'turns desc' },
      sessions: { shown: Math.min(BRIEF_SESSIONS, m.sessions.length), of: m.sessions.length, by: 'turns desc' },
      incidents: { shown: Math.min(BRIEF_INCIDENTS, m.incidents.length), of: m.incidents.length, by: 'output tokens desc' },
    },
    // Node/edge/position arrays are for drawing, not reading. The argument the
    // graph makes lives entirely in `related`, `bridges` and `gate`.
    graph: {
      related: m.graph.related,
      bridges: m.graph.bridges,
      gate: m.graph.gate,
      isolated: m.graph.isolated,
      nodeCount: m.graph.nodes.length,
      edgeCount: m.graph.edges.length,
    },
    projects: m.projects.slice(0, BRIEF_PROJECTS),
    sessions: m.sessions
      .slice()
      .sort((a, b) => b.turns - a.turns)
      .slice(0, BRIEF_SESSIONS)
      .map(({ topTools, cwd, bytes, ...rest }) => rest),
    incidents: m.incidents.slice(0, BRIEF_INCIDENTS),
  }
}

// ---------------------------------------------------------------- cli

const fmtTok = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n)
const pct = (n) => (n * 100).toFixed(0) + '%'

function summarize(m) {
  const L = []
  const spark = (key) => {
    const v = m.timeline.map((b) => b[key])
    const hi = Math.max(...v, 0.001)
    return v.map((x) => '▁▂▃▄▅▆▇█'[Math.min(7, Math.floor((x / hi) * 7.99))]).join('')
  }
  const ex = m.meta.excluded
  L.push(
    `corpus    ${m.meta.sessionCount} sessions · ${m.meta.turnCount} turns · ${m.meta.projectCount} projects · ${m.meta.span.days}d` +
      (ex.noHumanTurns ? `  (${ex.noHumanTurns} transcripts excluded: no human turns)` : '')
  )
  L.push(`span      ${String(m.meta.span.from).slice(0, 10)} → ${String(m.meta.span.to).slice(0, 10)}`)
  L.push(`volume    ${(m.meta.transcriptBytes / 1048576).toFixed(0)} MB transcript · ${m.meta.subagents.files} subagent transcripts (${(m.meta.subagents.bytes / 1048576).toFixed(0)} MB)`)
  L.push('')
  const t = m.totals
  L.push(`friction  ${pct(t.frictionRate)} of turns   rework ${pct(t.reworkRate)}   craft ${pct(t.craftRate)}`)
  L.push(`incidents ${t.repeats} repeats · ${t.interruptions} interrupts · ${t.corrections} corrections · ${t.compactions} compactions`)
  L.push(`tokens    ${fmtTok(t.tokens.output)} out · ${fmtTok(t.tokens.cacheRead)} cache-read · ${fmtTok(t.wastedTokens)} on turns that needed rework`)
  L.push('')
  if (m.trend.measurable) {
    const d = m.trend
    L.push(`trend     ${d.direction}  (rework ${pct(d.reworkRate.from)} → ${pct(d.reworkRate.to)}, first vs last ${d.weeksCompared} weeks)`)
    L.push(`          friction ${spark('frictionRate')}  craft ${spark('craftRate')}  turns ${spark('turns')}`)
  } else {
    L.push(`trend     not measurable — ${m.trend.why}`)
  }
  L.push('')
  L.push('incident taxonomy')
  for (const [, v] of Object.entries(m.taxonomy).sort((a, b) => b[1].count - a[1].count)) {
    if (!v.count) continue
    L.push(
      `  ${String(v.count).padStart(4)}  ${v.label.padEnd(32)} ${pct(v.turnRate).padStart(4)} of turns · ${String(v.sessions).padStart(2)} sessions · ${fmtTok(v.outputTokens)} out`
    )
  }
  L.push('')
  L.push('prompt-form signals (rework rate, workload-controlled)')
  for (const s of m.signals) {
    const mark = s.reliable ? '✓' : '·'
    const raw = `raw ${s.raw.delta > 0 ? '+' : ''}${pct(s.raw.delta)}`
    const pooledStr = s.strataUsed >= 2 ? `ctrl ${s.pooledDelta > 0 ? '+' : ''}${pct(s.pooledDelta)} z=${s.z}` : 'ctrl n/a'
    L.push(`  ${mark} ${s.signal.padEnd(22)} n=${String(s.raw.on.n).padStart(4)}  ${raw.padEnd(11)} ${pooledStr.padEnd(16)} ${s.verdict}`)
    if (s.rawMisleading) L.push('      ↳ raw figure is confounded by task difficulty — do not quote it')
  }
  L.push('')
  L.push('models')
  for (const mo of m.models.rollup) {
    L.push(
      `  ${mo.name.padEnd(20)} ${String(mo.turns).padStart(4)} turns ${String(mo.weeks).padStart(2)}w  rework ${pct(mo.reworkRate).padStart(4)}  ${mo.toolsPerTurn.toFixed(1)} tools/turn  ${fmtTok(mo.outputPerTurn)}/turn  appeared ${String(mo.firstAppeared).slice(0, 10)} · led ${String(mo.firstLed).slice(0, 10)}→${String(mo.lastLed).slice(0, 10)}${mo.comparable ? '' : '  (not compared)'}`
    )
  }
  for (const p of m.models.pairs) {
    L.push(`  ${p.comparable && p.significant ? '✓' : '·'} ${p.a} vs ${p.b}: ${p.why}`)
  }
  L.push('')
  L.push('busiest projects')
  for (const p of m.projects.slice(0, 8)) {
    L.push(
      `  ${p.name.slice(0, 30).padEnd(31)} ${String(p.sessions).padStart(2)} sess ${String(p.turns).padStart(4)} turns  rework ${pct(p.reworkRate).padStart(4)}  ${fmtTok(p.outputTokens)} out`
    )
  }
  if (m.caveats.length) {
    L.push('')
    L.push('caveats')
    for (const c of m.caveats) L.push(`  - ${c}`)
  }
  return L.join('\n')
}

const isMain = process.argv[1] && process.argv[1].endsWith('corpus.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : d
  }
  if (!existsSync(PROJECTS)) {
    console.error(`no transcripts found at ${PROJECTS}`)
    process.exit(1)
  }
  const model = await buildCorpus({
    projectFilter: opt('--project'),
    since: parseSince(opt('--since')),
    limit: opt('--limit'),
  })
  if (!model.meta.sessionCount) {
    console.error('no sessions matched the filter')
    process.exit(1)
  }
  // One parse, two consumers: the renderer needs everything, a reader needs the
  // capped view. Writing both here avoids running the whole extraction twice.
  const briefOut = opt('--brief-out')
  if (briefOut) {
    writeFileSync(briefOut, JSON.stringify(brief(model), null, 2))
    if (!argv.includes('--json')) console.error(`brief written to ${briefOut}`)
  }
  console.log(argv.includes('--json') ? JSON.stringify(model, null, 2) : summarize(model))
}
