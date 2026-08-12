#!/usr/bin/env node
// Extracts the "human spine" of a Claude Code session transcript.
//
// A session JSONL is mostly tool results and assistant messages; genuine human
// turns are ~2-4% of records. This collapses a transcript (often tens of MB)
// into a compact model keyed on those turns, with everything each turn caused
// attributed to it.
//
// Segmentation note: assistant records carry no promptId, so turns are cut by
// document order between human turns rather than grouped by id.

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const PROJECTS = join(homedir(), '.claude', 'projects')

// ---------------------------------------------------------------- classifying

// User-role records are not all typed prompts. Three groups, enumerated from
// the tags that actually occur across the transcript corpus:
//
//   SLASH    - the CLI's echo of a slash command invocation
//   INJECTED - background machinery reporting in (task notifications, CI
//              events, compaction summaries). Never human intent.
//   IDE      - wrapped, but genuinely user-initiated (clicking an element in
//              the IDE integration). Counted as a turn, flagged as non-typed.
const SLASH = /^<(command-name|command-message|command-args|local-command-caveat|local-command-stdout|local-command-stderr|user-prompt-submit-hook)\b/
const INJECTED = /^<(task-notification|task-id|tool-use-id|status|output-file|ci-monitor-event|event|diagnostics|usage|result|note|siblings|create-pr-command)\b/
const IDE = /^<(launch-selected-element|selected-lines|open-file)\b/
// Compaction leaves two traces in the user role: the <summary> payload itself
// and the resume preamble that opens the continued session. Neither is typed.
const COMPACTION = /^(<summary>|This session is being continued from a previous conversation)/
const INTERRUPT = /\[Request interrupted by user/
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n')
}

function classifyUser(rec) {
  if (rec.toolUseResult) return { kind: 'tool_result' }
  const content = rec.message?.content
  if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) {
    return { kind: 'tool_result' }
  }
  const hasImage = Array.isArray(content) && content.some((b) => b.type === 'image')
  const raw = textOf(content)
  if (INTERRUPT.test(raw)) return { kind: 'interrupt' }

  const text = raw.replace(REMINDER, '').trim()
  if (COMPACTION.test(text)) return { kind: 'compaction' }
  if (INJECTED.test(text)) return { kind: 'injected' }
  if (SLASH.test(text)) {
    const cmd = text.match(/^<command-name>\s*([^<]+)/)
    return { kind: 'slash', command: cmd ? cmd[1].trim() : null }
  }
  if (IDE.test(text)) return { kind: 'human', text, hasImage, typed: false }
  if (!text) return hasImage ? { kind: 'human', text: '[image]', hasImage, typed: true } : { kind: 'empty' }
  return { kind: 'human', text, hasImage, typed: true }
}

// ---------------------------------------------------------------- redaction

const SECRETS = [
  [/sk-ant-[\w-]{20,}/g, 'sk-ant-«redacted»'],
  [/\b(ghp|gho|ghs|ghu)_[A-Za-z0-9]{30,}\b/g, 'gh«redacted»'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA«redacted»'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, 'xox«redacted»'],
  [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'jwt«redacted»'],
  // KEY=value / TOKEN: value in pasted env blocks
  [/\b([A-Z][A-Z0-9_]{3,}(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|DSN))\s*[=:]\s*\S+/g, '$1=«redacted»'],
  [/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s"'`]+/g, '«redacted-conn-string»'],
]

function redact(s) {
  return SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), s)
}

// ---------------------------------------------------------------- signals

const FILE_REF = /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|rb|php|md|json|ya?ml|toml|css|scss|html|sql|sh|vue|svelte)\b/i
const CORRECTION = /^\s*(no+\b|nope\b|actually\b|wait\b|hold on\b|that'?s not\b|thats not\b|i meant\b|instead\b|nein\b|doch\b|falsch\b)/i
const CRITERIA = /\b(should|must|expect(ed)?|so that|acceptance|verify|ensure|make sure|test that|criteria|definition of done)\b/i
const QUESTION = /\?\s*$/

function signals(text) {
  const words = text.split(/\s+/).filter(Boolean).length
  return {
    chars: text.length,
    words,
    terse: words < 6,
    hasFileRef: FILE_REF.test(text),
    hasCodeBlock: text.includes('```'),
    hasUrl: /https?:\/\//.test(text),
    isQuestion: QUESTION.test(text),
    isCorrection: CORRECTION.test(text),
    hasAcceptanceCriteria: CRITERIA.test(text),
  }
}

// ---------------------------------------------------------------- scoring

// Two tiers of evidence, deliberately weighted apart.
//
// OUTCOME penalties are things the transcript witnessed: the prompt was re-sent,
// the work was interrupted, the next turn opened with a correction. These are
// facts about what a prompt cost, so they dominate the score.
//
// FORM adjustments are guesses from the text alone. A prompt that merely *reads*
// as vague may have worked fine, so these move the number only a little.
const OUTCOME = {
  repeated: [-30, 're-sent verbatim — the first attempt did not land'],
  interrupted: [-25, 'work had to be interrupted mid-flight'],
  'drew-correction': [-20, 'the next turn opened with a correction'],
  correction: [-10, 'this turn was itself a correction'],
  roundtrip: [-8, 'no tools ran and no question was asked'],
}

// An ordinary prompt that simply worked starts here, not at 100. Starting at a
// perfect score makes "no friction" indistinguishable from "well specified",
// and pins any real session near the ceiling.
const BASE = 72

function scoreTurn(t) {
  const deductions = []
  const additions = []

  for (const f of t.friction) {
    const rule = OUTCOME[f]
    if (rule) deductions.push({ points: rule[0], why: rule[1], tier: 'outcome' })
  }

  if (t.signals.hasAcceptanceCriteria) additions.push({ points: 10, why: 'stated what done looks like', tier: 'form' })
  if (t.signals.hasFileRef) additions.push({ points: 6, why: 'named a concrete file', tier: 'form' })
  if (t.signals.hasCodeBlock) additions.push({ points: 4, why: 'included code or output', tier: 'form' })

  // Terseness is only a defect when starting fresh work. Mid-flight steering is
  // terse by nature and lands precisely because the context is already loaded.
  if (t.signals.terse && !t.steering) {
    deductions.push({ points: -10, why: 'very short with no prior context to lean on', tier: 'form' })
  }

  const delta = [...deductions, ...additions].reduce((n, x) => n + x.points, 0)
  const value = Math.max(0, Math.min(100, BASE + delta))
  return { value, deductions, additions }
}

function band(v) {
  if (v >= 88) return 'clean'
  if (v >= 76) return 'solid'
  if (v >= 62) return 'mixed'
  if (v >= 45) return 'costly'
  return 'poor'
}

// The session score is built from *rates*, not from a mean of turn scores.
// Averaging hundreds of turns converges on the base value by construction, which
// made every session land in a narrow band regardless of how it actually went.
// Rates keep their spread no matter how long the session runs.
function scoreSession(turns) {
  if (!turns.length) return { value: null, band: null, confidence: 'none', turnsScored: 0 }

  // Friction is counted per turn, deliberately NOT weighted by tokens. Weighting
  // by cost inverts the signal: an interrupted turn is cheap *because* it was
  // interrupted, and a verbatim repeat costs almost nothing, so token-weighting
  // erases the very failures being measured. Wasted tokens are reported
  // separately instead, where they inform without distorting.
  const frictionTurns = turns.filter((t) => t.friction.length)
  const frictionRate = frictionTurns.length / turns.length
  const wastedTokens = frictionTurns.reduce((n, t) => n + t.tokens.output, 0)

  const crafted = turns.filter(
    (t) => t.signals.hasAcceptanceCriteria || t.signals.hasFileRef || t.signals.hasCodeBlock
  ).length
  const craftRate = crafted / turns.length

  const value = Math.max(0, Math.min(100, Math.round(100 - 120 * frictionRate + 20 * craftRate)))

  // Short sessions give the outcome signals almost nothing to witness, so the
  // number carries its own weakness rather than posing as a verdict.
  const confidence = turns.length >= 20 ? 'high' : turns.length >= 8 ? 'medium' : 'low'

  return {
    value,
    band: band(value),
    confidence,
    turnsScored: turns.length,
    frictionRate: +frictionRate.toFixed(3),
    craftRate: +craftRate.toFixed(3),
    wastedTokens,
    costliestTurn: turns.slice().sort((a, b) => a.score.value - b.score.value)[0]?.index ?? null,
  }
}

// ---------------------------------------------------------------- token accum

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

function addUsage(acc, usage) {
  if (!usage) return
  acc.input += usage.input_tokens || 0
  acc.output += usage.output_tokens || 0
  acc.cacheRead += usage.cache_read_input_tokens || 0
  acc.cacheCreate += usage.cache_creation_input_tokens || 0
}

// ---------------------------------------------------------------- extraction

export async function extract(file, { redactText = true, maxPromptChars = 4000 } = {}) {
  const session = {
    sessionId: null,
    file,
    project: basename(file.replace(/\/[^/]+$/, '')),
    cwd: null,
    gitBranch: null,
    version: null,
    title: null,
    startedAt: null,
    endedAt: null,
    models: {},
    slashCommands: [],
    permissionModes: [],
    totals: {
      records: 0,
      humanTurns: 0,
      assistantMessages: 0,
      toolCalls: 0,
      sidechainRecords: 0,
      interruptions: 0,
      compactions: 0,
      steeringTurns: 0,
      tokens: emptyTokens(),
    },
    turns: [],
  }

  let current = null

  const newTurn = ({ index, uuid, ts, text, promptId = null, hasImage = false, steering = false, origin = null, effort = null }) => ({
    index,
    promptId,
    uuid,
    startedAt: ts,
    endedAt: null,
    durationMs: 0,
    text: text.length > maxPromptChars ? text.slice(0, maxPromptChars) + '\n…[truncated]' : text,
    fullChars: text.length,
    hasImage,
    steering,
    origin,
    signals: signals(text),
    tokens: emptyTokens(),
    assistantMessages: 0,
    subagents: 0,
    interruptions: 0,
    slashCommands: [],
    effort,
    firstToolAt: null,
    timeToFirstToolMs: null,
    _tools: {},
  })

  const closeTurn = (ts) => {
    if (!current) return
    current.endedAt = ts || current.startedAt
    current.durationMs = Date.parse(current.endedAt) - Date.parse(current.startedAt) || 0
    current.toolCalls = Object.entries(current._tools)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
    current.toolCallCount = current.toolCalls.reduce((n, t) => n + t.count, 0)
    delete current._tools
    session.turns.push(current)
    current = null
  }

  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of rl) {
    if (!line.trim()) continue
    let rec
    try {
      rec = JSON.parse(line)
    } catch {
      continue // tolerate a torn final line on a live session
    }
    session.totals.records++

    const ts = rec.timestamp
    if (ts) {
      if (!session.startedAt) session.startedAt = ts
      session.endedAt = ts
    }
    if (!session.sessionId && rec.sessionId) session.sessionId = rec.sessionId
    if (!session.cwd && rec.cwd) session.cwd = rec.cwd
    if (!session.gitBranch && rec.gitBranch) session.gitBranch = rec.gitBranch
    if (!session.version && rec.version) session.version = rec.version
    if (rec.isSidechain) session.totals.sidechainRecords++

    switch (rec.type) {
      case 'ai-title':
      case 'custom-title':
        // later titles supersede earlier ones
        session.title = rec.title || rec.customTitle || rec.aiTitle || session.title
        break

      case 'mode':
        if (rec.mode) session.permissionModes.push({ ts, mode: rec.mode })
        break

      // Messages sent while a turn is still running are not user records at all
      // — they arrive as queued_command attachments. They are genuine human
      // instructions and they redirect the work that follows, so they open a new
      // turn, flagged to distinguish steering from a fresh prompt.
      case 'attachment': {
        if (rec.attachment?.type !== 'queued_command') break
        // prompt is a string for typed text, but an array of content blocks when
        // the user pastes images mid-flight. textOf handles both; base64 image
        // payloads are dropped rather than carried into the spine.
        const p = rec.attachment.prompt
        const hasImage = Array.isArray(p) && p.some((b) => b.type === 'image')
        const raw = textOf(p).replace(REMINDER, '').trim()
        if (!raw && !hasImage) break
        closeTurn(ts)
        session.totals.humanTurns++
        session.totals.steeringTurns++
        const body = raw || '[image]'
        current = newTurn({
          index: session.totals.humanTurns - 1,
          uuid: rec.attachment.source_uuid || rec.uuid,
          ts,
          text: redactText ? redact(body) : body,
          hasImage,
          steering: true,
          origin: rec.attachment.origin || null,
        })
        break
      }

      case 'assistant': {
        session.totals.assistantMessages++
        const model = rec.message?.model
        if (model) session.models[model] = (session.models[model] || 0) + 1
        addUsage(session.totals.tokens, rec.message?.usage)
        if (current) {
          addUsage(current.tokens, rec.message?.usage)
          current.assistantMessages++
          if (rec.effort) current.effort = rec.effort
        }
        for (const block of rec.message?.content || []) {
          if (block.type !== 'tool_use') continue
          session.totals.toolCalls++
          if (!current) continue
          current._tools[block.name] = (current._tools[block.name] || 0) + 1
          if (!current.firstToolAt) {
            current.firstToolAt = ts
            current.timeToFirstToolMs = Date.parse(ts) - Date.parse(current.startedAt) || 0
          }
          if (block.name === 'Task' || block.name === 'Agent') current.subagents++
        }
        break
      }

      case 'user': {
        const c = classifyUser(rec)
        if (c.kind === 'interrupt') {
          session.totals.interruptions++
          if (current) current.interruptions++
          break
        }
        if (c.kind === 'slash') {
          if (c.command) {
            session.slashCommands.push(c.command)
            if (current) current.slashCommands.push(c.command)
          }
          break
        }
        if (c.kind === 'compaction') {
          session.totals.compactions++
          break
        }
        if (c.kind !== 'human') break

        closeTurn(ts)
        session.totals.humanTurns++
        const text = redactText ? redact(c.text) : c.text
        current = newTurn({
          index: session.totals.humanTurns - 1,
          promptId: rec.promptId || null,
          uuid: rec.uuid,
          ts,
          text,
          hasImage: !!c.hasImage,
          effort: rec.effort || null,
        })
        break
      }
    }
  }
  closeTurn(session.endedAt)

  // Cross-turn signals. These are the honest quality metrics: they measure what
  // a prompt actually cost rather than how well-written it looks.
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  const seen = new Map()

  session.turns.forEach((t, i) => {
    const next = session.turns[i + 1]
    const key = norm(t.text)
    // A near-identical prompt sent twice means the first one did not land.
    const repeatOf = key.length > 12 && seen.has(key) ? seen.get(key) : null
    if (key.length > 12 && !seen.has(key)) seen.set(key, i)

    t.derived = {
      noToolCalls: t.toolCallCount === 0,
      clarificationRoundtrip: t.toolCallCount === 0 && !!next,
      followedByCorrection: !!next?.signals.isCorrection,
      repeatOf,
    }
    // Friction = the prompt failed to land the first time, in any of the ways
    // the transcript can actually witness.
    //
    // A tool-less turn only counts as friction when it was *not* a question:
    // answering "explain onnx" without touching a tool is the correct outcome,
    // not a failed prompt.
    t.friction = [
      t.interruptions > 0 && 'interrupted',
      repeatOf !== null && 'repeated',
      t.signals.isCorrection && 'correction',
      t.derived.followedByCorrection && 'drew-correction',
      t.derived.clarificationRoundtrip && !t.signals.isQuestion && 'roundtrip',
    ].filter(Boolean)

    t.score = scoreTurn(t)
  })

  session.score = scoreSession(session.turns)

  const f = session.turns.filter((t) => t.friction.length)
  session.totals.frictionTurns = f.length
  session.totals.frictionRate = session.turns.length ? +(f.length / session.turns.length).toFixed(3) : 0
  session.totals.repeats = session.turns.filter((t) => t.derived.repeatOf !== null).length
  session.totals.corrections = session.turns.filter((t) => t.signals.isCorrection).length

  session.durationMs = Date.parse(session.endedAt) - Date.parse(session.startedAt) || 0
  return session
}

// ---------------------------------------------------------------- discovery

export function listSessions(projectFilter) {
  if (!existsSync(PROJECTS)) return []
  const out = []
  for (const proj of readdirSync(PROJECTS)) {
    if (projectFilter && !proj.includes(projectFilter)) continue
    const dir = join(PROJECTS, proj)
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue
      const full = join(dir, f)
      const st = statSync(full)
      out.push({ project: proj, file: full, size: st.size, mtime: st.mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

function resolveTarget(arg, projectFilter) {
  if (arg && existsSync(arg)) return arg
  const all = listSessions(projectFilter)
  if (!all.length) return null
  if (arg) {
    const hit = all.find((s) => basename(s.file).startsWith(arg))
    return hit ? hit.file : null
  }
  return all[0].file
}

// ---------------------------------------------------------------- cli

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return Math.round(n / 1e3) + 'k'
  return String(n)
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm'
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm'
}

function summarize(s) {
  const L = []
  L.push(`session   ${s.sessionId}`)
  L.push(`title     ${s.title || '—'}`)
  L.push(`cwd       ${s.cwd}   branch:${s.gitBranch || '—'}`)
  L.push(`span      ${s.startedAt} → ${s.endedAt}  (${fmtDuration(s.durationMs)})`)
  L.push(`models    ${Object.entries(s.models).map(([m, n]) => `${m}×${n}`).join(', ') || '—'}`)
  L.push('')
  const t = s.totals
  L.push(
    `records ${t.records}  human-turns ${t.humanTurns}  assistant ${t.assistantMessages}  ` +
      `tool-calls ${t.toolCalls}  interruptions ${t.interruptions}  sidechain ${t.sidechainRecords}`
  )
  L.push(
    `tokens  in ${fmtTokens(t.tokens.input)}  out ${fmtTokens(t.tokens.output)}  ` +
      `cache-read ${fmtTokens(t.tokens.cacheRead)}  cache-write ${fmtTokens(t.tokens.cacheCreate)}`
  )
  L.push('')
  L.push('  #  dur     tools  out-tok  flags  prompt')
  for (const turn of s.turns) {
    const flags = [
      turn.interruptions ? 'INT' : '',
      turn.signals.isCorrection ? 'CORR' : '',
      turn.derived.clarificationRoundtrip ? 'RT' : '',
      turn.signals.terse ? 'TERSE' : '',
      turn.signals.hasAcceptanceCriteria ? 'AC' : '',
      turn.signals.hasFileRef ? 'REF' : '',
    ].filter(Boolean).join(',')
    const preview = turn.text.replace(/\s+/g, ' ').slice(0, 62)
    L.push(
      `${String(turn.index).padStart(3)}  ${fmtDuration(turn.durationMs).padEnd(6)}  ` +
        `${String(turn.toolCallCount).padStart(5)}  ${fmtTokens(turn.tokens.output).padStart(7)}  ` +
        `${flags.padEnd(18)}  ${preview}`
    )
  }
  return L.join('\n')
}

const isMain = process.argv[1] && import.meta.url.endsWith(basename(process.argv[1]))
if (isMain) {
  const argv = process.argv.slice(2)
  const flag = (n) => argv.includes(n)
  const opt = (n) => {
    const i = argv.indexOf(n)
    return i >= 0 ? argv[i + 1] : null
  }

  if (flag('--list')) {
    const rows = listSessions(opt('--project')).slice(0, Number(opt('--limit') || 20))
    for (const r of rows) {
      console.log(
        `${new Date(r.mtime).toISOString().slice(0, 16)}  ${String(Math.round(r.size / 1024)).padStart(7)}k  ` +
          `${basename(r.file).slice(0, 8)}  ${r.project}`
      )
    }
    process.exit(0)
  }

  const positional = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--project' && argv[argv.indexOf(a) - 1] !== '--limit')
  const target = resolveTarget(positional[0], opt('--project'))
  if (!target) {
    console.error('no session found. try --list')
    process.exit(1)
  }
  const result = await extract(target, { redactText: !flag('--no-redact') })
  console.log(flag('--json') ? JSON.stringify(result, null, 2) : summarize(result))
}
