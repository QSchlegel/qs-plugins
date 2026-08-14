---
name: qcost
description: Where the tokens actually go — cache-read versus generated output, and how much context each agent family replays per run. Use when the user runs /qcost, asks about token spend, why their bill is high, what an agent costs, or wants to reduce context usage.
disable-model-invocation: true
---

# qcost

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs --cost
```

## The thing this exists to show

Output — text the model generated — is a rounding error on the bill. Almost
everything is **cache-read**: context replayed to the model on every turn. It
appears in no per-session view, so it is invisible exactly where people look.

On the reference corpus it was 24.7B cache-read against 86M output. Output was
under half a percent of all tokens.

## Reading it

The **spread between agent families** is the actionable number, not the total.
Families doing comparable work with a several-fold difference in cache-read per
run differ by prompt, not by model or harness — and the widest one is a file you
can edit.

The friction metrics in `/qtrends` cover a low-single-digit share of spend. If
someone is optimising for cost, this page is where the money is and that one is
not. Say that plainly rather than letting both look equally important.

## Rules

- **No currency.** The rate card is not part of the snapshot, and a dollar figure
  derived from an assumed price is an assumption rendered as a fact. If the user
  wants money, ask them for their rate card and show the arithmetic.
- Quote linear share and the log view together when explaining composition. A
  linear bar hides output entirely; a log chart hides the dominance. Either
  alone misleads.
- Cache-read is not waste. It is the cost of the context the agent needed. The
  question is whether it needed all of it.
