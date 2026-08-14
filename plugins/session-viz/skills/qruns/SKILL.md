---
name: qruns
description: The delivery ledger for autonomous work — every scheduled run, subagent and workflow agent on this machine, with what it actually shipped. Shows which recurring tasks produce nothing, which runs died on a permission prompt, and how each one terminated. Use when the user runs /qruns, asks what their agents or cron jobs are doing, why a scheduled task is not producing output, or wants to see subagent activity.
disable-model-invocation: true
---

# qruns

`/qpact` and `/qtrends` both throw away the runs with no human in them, on
purpose — it keeps the prompting statistics honest. Those runs are the majority
of everything that executes and almost all of the token spend.

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/runs.mjs --json > /tmp/qruns.json
```

About five seconds for ~1,200 runs. `--since 30d` narrows the window.

## Read it in this order

1. **Recurring tasks.** A task with `<< STALLED` has run three or more times and
   produced no confirmed write. This is the headline finding and it is usually a
   surprise, because a stalled task looks healthy: coherent transcripts, sensible
   plans, often no errors at all.
2. **The `denied` column.** A permission the job was never granted. Headless runs
   cannot answer a prompt, so they die at the first write. The fix is a settings
   line, not a prompt change — check `permissionCoversWrite` with `/qdoctor`.
3. **Terminal states.** `completed_structured` is success. `unknown` means the
   classifier could not name how the run ended; report the count and do not
   guess at it.
4. **Subagent families.** Cache-read per run varies severalfold between families
   doing comparable work. That spread is the cheapest thing on the page to fix.

## Reporting rules

- **`cost/delivered` prints `undefined (N runs, X out, 0 delivered)` when nothing
  shipped.** Do not convert that to ∞, 0, or "N/A" — the honest output of a zero
  denominator is a refusal plus both raw numbers.
- **Never call `wrote_ok` "delivered".** No filesystem probe runs, so a write is
  a tool-result observation. The distinction matters the moment someone asks
  whether the file is really there.
- Subagent families come from a first-message heuristic. Say so when you quote a
  per-family number.
- If a task is stalled, say what it cost and how long it has been stalled. "17
  runs, 30 days, nothing" lands; "delivery rate 0%" does not.

## What to do next

A stalled task with `permission` errors → `/qdoctor` on that repo, then add the
allow entry. A wide cache-read spread → look at the widest family's opening
prompt. Neither of those is a prompting problem, which is the point of having
this separate from `/qtrends`.
