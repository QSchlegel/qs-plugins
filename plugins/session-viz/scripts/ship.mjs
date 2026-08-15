#!/usr/bin/env node
// Harvest prompts you keep re-typing into slash commands.
//
//   node ship.mjs                      # what repeats, and which are worth promoting
//   node ship.mjs --write <key>        # write .claude/commands/<name>.md for one
//
// The corpus tool counts a verbatim repeat as friction on the assumption the
// first attempt did not land. That is wrong about half the time: "ship to
// preprod" sent four times is four deploys, not four failures. The useful split
// is RITUAL from MISS, and it is decidable from what happened after the prompt:
//
//   MISS    the first attempt ran no tools, or drew a correction. Re-sending it
//           reproduced the no-op. Worth rewriting, not worth a command.
//   RITUAL  every instance ran tools and did work. You are hand-typing a
//           procedure. Worth a command.
//
// Detection pools across sessions. extract.mjs keeps its `seen` map per
// transcript, so a phrase you type weekly in different sessions is invisible to
// it — which is exactly the phrase most worth promoting.

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { extract, listSessions } from './extract.mjs'

const norm = (s) => String(s || '').toLowerCase()
  .replace(/\[image[^\]]*\]/g, ' ')
  .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()

// Phrases that are the harness talking, or too generic to promote.
// `base directory for this skill` is the preamble Claude Code prepends to a
// skill invocation — it is the single most repeated string in the corpus and
// none of it was typed by a human.
const SKIP = /^(continue|continue from where you left off|go ahead|yes|yes go ahead|ok|okay|thanks|next|proceed|do it|carry on|go|run it|y|n|authed|bring it up|deploy|run local|to preprod)$/
const MACHINE = /^(base directory for this skill|my computer went to sleep)/

export async function harvest({ minCount = 2 } = {}) {
  const groups = new Map()
  for (const f of listSessions()) {
    let s
    try { s = await extract(f.file) } catch { continue }
    if (!s.turns.length) continue
    const repo = (s.cwd || s.project).split('/.claude/worktrees/')[0]
    for (const t of s.turns) {
      const key = norm(t.text)
      if (key.length < 6 || SKIP.test(key) || MACHINE.test(key)) continue
      if (!groups.has(key)) groups.set(key, { key, text: t.text.trim(), hits: [] })
      groups.get(key).hits.push({
        repo: repo.replace(/^.*\//, ''), session: s.sessionId, at: t.startedAt,
        tools: t.toolCallCount || 0,
        toolNames: (t.toolCalls || []).map((x) => x.name),
        drewCorrection: !!t.derived?.followedByCorrection,
      })
    }
  }

  const out = []
  for (const g of groups.values()) {
    if (g.hits.length < minCount) continue
    const sessions = new Set(g.hits.map((h) => h.session)).size
    const repos = [...new Set(g.hits.map((h) => h.repo))]
    const worked = g.hits.filter((h) => h.tools > 0)
    const noop = g.hits.filter((h) => h.tools === 0)
    const drew = g.hits.filter((h) => h.drewCorrection).length
    // Ritual only if EVERY instance did work and none drew a correction. One
    // no-op is enough to make it a miss — that is the instance worth reading.
    const kind = noop.length === 0 && drew === 0 && worked.length >= 2 ? 'ritual'
      : worked.length === 0 ? 'miss' : 'mixed'
    const tools = new Map()
    for (const h of worked) for (const n of h.toolNames) tools.set(n, (tools.get(n) || 0) + 1)
    out.push({
      ...g, count: g.hits.length, sessions, repos, kind,
      crossSession: sessions > 1,
      medianTools: worked.length ? worked.map((h) => h.tools).sort((a, b) => a - b)[Math.floor(worked.length / 2)] : 0,
      noop: noop.length, drewCorrection: drew,
      tools: [...tools.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => ({ n, c })),
      // A command earns its place when the phrase recurs ACROSS sessions and
      // always does real work. Within one session it is just a retry.
      promote: kind === 'ritual' && sessions >= 2,
    })
  }
  return out.sort((a, b) => Number(b.promote) - Number(a.promote) || b.count - a.count)
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)

export function commandFile(item) {
  const name = slug(item.text.split('\n')[0])
  const tools = item.tools.map((t) => t.n).join(', ')
  return {
    name,
    path: `.claude/commands/${name}.md`,
    body: `---
description: ${item.text.split('\n')[0].slice(0, 100)}
---

${item.text.trim()}

<!--
Promoted by /qship from ${item.count} occurrences across ${item.sessions} sessions
in ${item.repos.join(', ')}. Every instance ran tools (median ${item.medianTools})
and none drew a correction, so this was a procedure being retyped rather than a
prompt that failed to land.

Tools these runs actually used: ${tools || '—'}

Edit freely — this is a starting point taken from what you typed, not a spec.
-->
`,
  }
}

// ---------------------------------------------------------------- cli

const isMain = process.argv[1] && process.argv[1].endsWith('ship.mjs')
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null }
  const items = await harvest({ minCount: Number(opt('--min') || 2) })

  if (argv.includes('--json')) { console.log(JSON.stringify(items, null, 2)); process.exit(0) }

  const target = opt('--write')
  if (target) {
    const item = items.find((i) => i.key.startsWith(norm(target)))
    if (!item) { console.error(`no repeated prompt matching "${target}"`); process.exit(1) }
    if (!item.promote) console.error(`note: this one is classified "${item.kind}", not a ritual — writing anyway`)
    const f = commandFile(item)
    mkdirSync('.claude/commands', { recursive: true })
    if (existsSync(f.path)) { console.error(`${f.path} already exists — not overwriting`); process.exit(1) }
    writeFileSync(f.path, f.body)
    console.log(`wrote ${f.path}`)
    console.log(`review it, then commit on a branch — never straight to main.`)
    process.exit(0)
  }

  const promote = items.filter((i) => i.promote)
  const misses = items.filter((i) => i.kind === 'miss')
  const mixed = items.filter((i) => i.kind === 'mixed')

  const line = (i) => `  ${String(i.count).padStart(2)}× in ${String(i.sessions).padStart(2)} sessions  ${i.repos.slice(0, 2).join(',').padEnd(22)} ${JSON.stringify(i.text.slice(0, 62))}`

  console.log(`RITUALS — worth a slash command (${promote.length})`)
  console.log(promote.length ? promote.map(line).join('\n') : '  none')
  if (promote.length) {
    console.log(`\n  promote one with:  node ship.mjs --write "${promote[0].text.slice(0, 24)}"`)
  }
  console.log(`\nMISSES — every instance ran no tools (${misses.length})`)
  console.log(misses.length ? misses.map(line).join('\n') : '  none')
  if (misses.length) console.log('  Re-sending these reproduced the no-op. Rewrite them; a command would not help.')
  console.log(`\nMIXED — worked sometimes (${mixed.length})`)
  console.log(mixed.length ? mixed.slice(0, 8).map(line).join('\n') : '  none')
  console.log(`\n  Pooled across sessions. The per-session view in /qtrends cannot see a phrase`)
  console.log(`  you type weekly in different sessions, which is the kind most worth promoting.`)
}
