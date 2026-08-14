---
name: qtrends
description: Analyse every Claude Code session on this machine — friction and craft trends over time, an incident taxonomy with cost attribution, per-project comparison, and real repeat/correction exemplars — then render it as an interactive HTML report opened in a preview window. Use when the user runs /qtrends, or asks about prompting trends, historic patterns across sessions, whether they are improving, or which projects go badly.
disable-model-invocation: true
---

# qtrends

Corpus-wide sibling of `/qpact`. That one asks "how did this session go"; this one
asks "how am I going", across every transcript on the machine.

## The two ways this goes wrong

### Model releases are confounded with time

You adopt a new model and stop using the old one, so "newer model, less rework"
and "you got better over those same weeks" are literally the same rows. In the
current corpus opus-5 has less than half the rework rate of opus-4-8 — and they
never ran at volume in the same week, so that gap is unattributable.

`models.pairs` states, per pair, whether a contemporaneous comparison was
possible. **Only quote a model difference when `comparable` and `significant`
are both true.** Otherwise report the rates as description and say plainly that
the release cannot be credited. The per-model table is not a benchmark.

### Prompt-form correlations are confounded with difficulty

The corpus is small and the outcome is rare — roughly 1300 turns at a ~6% rework
rate. That is enough to see a *trend* and to count *incidents*, and nowhere near
enough to support "prompts phrased like X work better".

Worse, the naive correlations are actively inverted. Long prompts that name files
and paste code are the ones sent for hard work, so raw rates make good prompting
look expensive. In the current corpus the unadjusted figure says naming a file
*doubles* friction. It does not; it marks a hard task.

`corpus.mjs` already handles this: every prompt-form signal is stratified by
tool-call count, gated on a two-proportion z-test and an incident floor, and
carries `reliable`, `verdict` and `rawMisleading`. **Your job is to respect the
gate, not to re-litigate it.**

- Never quote a `raw` delta. Not once, not "for context".
- Cite a signal as evidence only when `reliable` is `true`.
- When nothing is reliable, say so plainly. "No prompt-phrasing pattern in your
  history holds up statistically" is the correct, useful finding — not a gap to
  fill with plausible-sounding advice.

Advice comes from the trend, the incident taxonomy and the exemplars. Those are
counts of things that actually happened, and they need no significance test.

## Steps

### 1. Build the corpus model

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/corpus.mjs --json \
  --brief-out /tmp/qtrends-brief.json > /tmp/qtrends-corpus.json
```

Parses every session (~2s for 60 sessions / 600 MB). One pass, two files: the
full model for the renderer, and a capped `--brief-out` view for you to read —
same aggregates, with the long tails (sessions, projects, incidents) trimmed and
the caps declared under `truncated`. Read the brief, not the full file; it grows
linearly with the corpus.

Add `--project <substr>` to scope to one repo, `--since 30d` (or `12w`, `3m`, or
an ISO date) to scope by time. Prompts are secret-redacted.

For a quick look without the report, drop `--json` for a text summary.

### 2. Report the shape in chat — briefly

Read `/tmp/qtrends-brief.json` and state, in no more than four lines: corpus
size and span, the trend direction with its two rework figures, the largest
incident category, and one thing you will look into. Terse — the detail belongs
in the report.

Use the computed numbers verbatim. `trend.direction` is already derived; do not
re-derive a different one from `timeline`.

### 3. Write the reading

Write `/tmp/qtrends-advice.json`:

```json
{
  "tldr": "One paragraph: what the corpus shows about how this person works, and what changed over the span.",
  "supported": ["Claims the data carries — each one anchored on a count, a rate, or a named exemplar."],
  "changes": ["What moved between the early and late weeks, with both figures."],
  "connections": ["Repositories that share real tooling, and what that means for reuse."],
  "recommendations": ["Concrete, drawn from exemplars and incident counts."],
  "unsupported": ["Things a reader would expect this report to say that it cannot — including any signal that failed the gate."]
}
```

Rules for each field:

- **supported** — every entry cites a number from the model or a specific
  exemplar. `taxonomy.<tag>.count`, `timeline`, `projects[].reworkRate`,
  `exemplars.*`. No entry may rest on a signal whose `reliable` is `false`.
- **changes** — quote `trend.reworkRate.from` and `.to` and the week ranges.
  If `trend.direction` is `flat`, say it is flat; do not narrate a slope.
- **recommendations** — the exemplars are the richest material here. Read
  `exemplars.repeats` as a set and say what those prompts have in common;
  read `exemplars.corrections` for what the preceding turn left ambiguous.
  A recommendation that does not trace to an incident you can point at is not
  worth writing.
- **connections** — read `graph.related` and `graph.bridges`. Name the two or
  three repository pairs with the highest score and say what they share and why
  it matters — a pair on the same database and framework is a pair where a fix
  in one is a fix in the other. Ignore `graph.gate.droppedUniversal`: those are
  your toolchain, not connections. Note `graph.isolated` if anything sits apart.

- **unsupported** — put the failed signals here with their `verdict`, every
  non-comparable model pair with the reason, and every entry from `caveats`.
  This section is the honest half of the report; make it substantive rather
  than a disclaimer. If a model looks better and cannot be shown to be, say so
  here explicitly — that is the claim a reader will otherwise make for you.

Where the corpus is dominated by one session or one project, say whose numbers
these really are.

### 4. Render and open

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/render-corpus.mjs /tmp/qtrends-corpus.json \
  --advice /tmp/qtrends-advice.json --open
```

Prints the path and opens a window: trend chart, model adoption bars and gated
pair comparisons, taxonomy, the gated signal cards, exemplars, and expandable
per-project and per-session cards that drill into their own metrics and rework
incidents. Pass the **full** corpus JSON here, not the brief.

### 5. Close out

One line: the file path and the single most actionable thing in it. Do not
restate the report in chat.
