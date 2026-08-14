# qs-plugins

A Claude Code plugin marketplace, plus the optional hosted backend for session-viz.

```
plugins/session-viz/   the plugin — /qpact and /qtrends, fully local
cloud/                 optional hosted side: API, landing page, pricing model
```

Everything in `cloud/` is optional. The plugin works completely without it, and no data
leaves your machine unless you explicitly push it.

```bash
claude plugin marketplace add QSchlegel/qs-plugins
```

## session-viz

Two commands:

- **`/qpact`** — analyse the current session, render an interactive HTML report
  into a pop-out window, and derive a `/compact` instruction tuned to what the
  session was actually about.
- **`/qtrends`** — analyse *every* session on the machine: friction and craft
  over time, an incident taxonomy, per-project comparison, and the actual
  prompts that had to be re-sent.
- **`/qteam`** — the optional shared layer: federated Obsidian vaults whose
  `[[wikilinks]]` resolve across projects and people, and task handoff between
  teammates. Talks to the hosted stateless MCP; needs `SESSION_VIZ_TOKEN` and
  `SESSION_VIZ_ACTOR` set, and a session restart.

```bash
claude plugin install session-viz@qs-plugins
```

Plugin skills register at session start, so start a new session before the
commands resolve.

### What `/qpact` does

1. **Extract** — streams the session transcript into a compact turn spine.
   Human turns are only 2–4% of records, so a 42 MB transcript collapses to
   ~100 KB in under a second.
2. **Score** — deterministic prompting-quality metrics (see below).
3. **Derive** — Claude writes a TL;DR, an intent breakdown, and the `/compact`
   focus instructions.
4. **Render** — a self-contained HTML file opened in a real window, with the
   `/compact` line copy-pasteable at the top.

`/compact` is a built-in command that only the user can invoke, and `PreCompact`
hooks cannot inject instructions into it — hence the copy-pasteable line rather
than automatic compaction.

### How the score works

Two tiers of evidence, weighted apart. **Outcome** penalties are things the
transcript witnessed and dominate the score; **form** adjustments are guesses
from the prompt text alone and move it only slightly.

| Outcome signal | Points |
| --- | --- |
| re-sent verbatim (the first attempt did not land) | −30 |
| interrupted mid-flight | −25 |
| drew a correction on the next turn | −20 |
| was itself a correction | −10 |
| no tools ran and no question was asked | −8 |

Turns start at **72**, not 100 — a prompt that merely did not fail is not the
same as a good one. Terseness is penalised only for fresh prompts, never for
mid-turn steering, which is short because the context is already loaded.

The session score is built from *rates*, not from a mean of turn scores:
averaging hundreds of turns converges on the baseline by construction. Friction
is counted per turn and deliberately **not** weighted by tokens — an interrupted
turn is cheap precisely because it was interrupted, so cost-weighting erases the
failures being measured. Wasted tokens are reported separately.

Below ~20 turns the score is reported with low confidence: the outcome signals
have too little to witness for the number to mean much.

### What `/qtrends` does

Parses every transcript under `~/.claude/projects` — around 600 MB and 60
sessions in ~2 seconds, so there is no cache to go stale. Only depth-2 files
(`projects/<slug>/<uuid>.jsonl`) are sessions; the ~1100 files nested under
`<uuid>/subagents/**` are subagent transcripts and are counted by size only.

It reports a weekly friction/craft trend, model adoption and per-model rates, an
incident taxonomy with token cost attached, expandable per-project and
per-session drill-downs, and — most usefully — the actual prompts that were
re-sent verbatim, paired with the corrections they drew.

Transcripts with no human turns (scheduled-task runs) are excluded and counted
separately; on this machine that is 23 of 63. Worktrees at
`<repo>/.claude/worktrees/<name>` roll up into their repository — otherwise one
repo worked across five worktrees looks like five unrelated projects.

#### Cross-project knowledge graph

An Obsidian-style graph view of what connects your repositories, built from what
sessions *did* rather than what prompts said: packages imported (parsed out of
Write/Edit content), CLIs run in Bash, stack files touched, and skills and MCP
servers invoked.

A topic is drawn only if it bridges **2 to half** of your repositories. Below
that it describes one repo and connects nothing; above it, it is your default
toolchain — `npm` and `package.json` spanned ten of sixteen repos here and made
every pair look related. Dropped topics are listed rather than hidden.

Relatedness between two repos is Jaccard overlap weighted by inverse document
frequency, so a shared `@prisma/client` counts for roughly three times a shared
`docker`. That surfaces pairs like `Baustoffe ↔ daemmwerk-newsroom` (prisma,
psql, schema.prisma, next) instead of "both are Node projects".

The layout is force-directed but computed at build time and seeded on a circle
by index — no `Math.random`, so the same corpus always draws the same graph.
Repos with no bridging topic are omitted from the drawing and named separately;
left in, they are free particles that get flung outward and squash everything
else into a corner.

#### Why model comparisons are gated too

A model release is confounded with time in the worst possible way: you adopt the
new model and stop using the old one, so "newer model, less rework" and "you got
better over those same weeks" are the same rows of data. Here opus-5 shows less
than half the rework rate of opus-4-8 — and the two never ran at volume in the
same week, so the gap is unattributable.

So models are compared only *within the weeks both ran at volume* (≥20 turns each
per week, ≥80 turns per side pooled), then z-tested. Pairs that never overlap are
reported as not comparable rather than ranked. Turns with no model record — the
request was aborted before anything ran — are excluded from every per-model rate,
since they are ~46% rework by construction.

#### Why the correlations are gated

A corpus this size sees roughly 1300 turns at a ~6% rework rate. That supports a
trend and an incident count. It does not support "prompts phrased like X work
better", and the naive numbers are worse than useless: long prompts that name
files and paste code are the ones sent for hard work, so the unadjusted figures
in this corpus say naming a file *doubles* friction. It marks a hard task, not a
bad prompt.

So every prompt-form signal is stratified by tool-call count, then gated on four
conditions — direction consistent across strata, ≥25 turns per arm in ≥2 strata,
≥8 rework incidents in the treated arm, and |z| ≥ 2 on a two-proportion test.
Signals that fail are shown with the reason they failed and marked
`raw figure misleads` where the unadjusted number points the other way.

Most of the time nothing passes. That is the finding, and the report says so
rather than filling the space with plausible advice.

The trend line has its own floor: at least 6 active weeks and 100 turns at each
end, otherwise it reports "not measurable" instead of reading a slope off two
weeks.

### Using the scripts directly

```bash
node plugins/session-viz/scripts/extract.mjs --list
node plugins/session-viz/scripts/extract.mjs --project my-repo --json > spine.json
node plugins/session-viz/scripts/render.mjs spine.json --open
```

```bash
node plugins/session-viz/scripts/corpus.mjs
node plugins/session-viz/scripts/corpus.mjs --json --brief-out brief.json > corpus.json
node plugins/session-viz/scripts/render-corpus.mjs corpus.json --open
```

`corpus.mjs` takes `--project <substr>`, `--since <30d|12w|3m|ISO date>` and
`--limit <n>`; with no `--json` it prints a text summary with sparklines.
`--brief-out` writes a capped companion model in the same pass — same
aggregates, long tails trimmed, caps declared under `truncated` — for when
something needs to read the model rather than render it.

`extract.mjs` redacts API keys, tokens, JWTs and connection strings from prompt
text by default. Transcripts contain whatever you have pasted into them; review
before sharing a report.

## Cloud

`cloud/services/api` runs two data planes from one service, kept apart structurally rather
than by policy:

- **Plane A** — fleet telemetry. Person-blind: closed schema, k-gated aggregates, signed
  reference table, and no person column anywhere.
- **Plane B** — collaboration. Federated Obsidian vaults, task handoff, live sync over SSE,
  and a stateless MCP endpoint. Identity-bearing, because handing work between people
  requires knowing them.

`assertPlaneSeparation()` runs at boot and refuses to start if a migration ever adds a
foreign key between them. See [cloud/README.md](cloud/README.md) and
[cloud/PRICING.md](cloud/PRICING.md).

## Licence

MIT — see [LICENSE](LICENSE).
