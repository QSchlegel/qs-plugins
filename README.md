# qs-plugins

A Claude Code plugin marketplace.

```bash
claude plugin marketplace add QSchlegel/qs-plugins
```

## session-viz

Provides **`/qpact`** — analyse the current session, render an interactive HTML
report into a pop-out window, and derive a `/compact` instruction tuned to what
the session was actually about.

```bash
claude plugin install session-viz@qs-plugins
```

Plugin skills register at session start, so start a new session before `/qpact`
resolves.

### What it does

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

### Using the scripts directly

```bash
node plugins/session-viz/scripts/extract.mjs --list
node plugins/session-viz/scripts/extract.mjs --project my-repo --json > spine.json
node plugins/session-viz/scripts/render.mjs spine.json --open
```

`extract.mjs` redacts API keys, tokens, JWTs and connection strings from prompt
text by default. Transcripts contain whatever you have pasted into them; review
before sharing a report.

## Licence

MIT
