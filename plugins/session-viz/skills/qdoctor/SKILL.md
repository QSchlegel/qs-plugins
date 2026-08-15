---
name: qdoctor
description: Audit this repository's Claude Code configuration against how the user's other repos are set up — CLAUDE.md, slash commands, hooks, and whether permissions cover Write. Use when the user runs /qdoctor, asks whether a repo is set up properly, why headless or scheduled runs fail on permissions, or wants to compare configuration across projects.
disable-model-invocation: true
---

# qdoctor

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs            # this repo
node ${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs --all      # every repo with transcripts
```

Repos are discovered from the `cwd` recorded in transcripts, and worktrees fold
back into their repository.

## What it compares against

The user's own other repos — never a best-practice list. "Eleven of your sixteen
repos have this and this one does not" is a fact about their setup. "You should
have a CLAUDE.md" is an opinion, and this skill does not offer opinions dressed
as findings.

A finding is a **gap** only when at least half the other repos have the thing
*and* there are at least four of them to compare against. Otherwise it is a
**note** — an observation with too little behind it. Keep that distinction when
you report; it is the difference between evidence and a hunch.

## The check that matters most

`permissionCoversWrite`. A scheduled or headless run cannot answer a permission
prompt, so without a Write entry in `permissions.allow` it dies at the first
write — after doing all the work. This is the most common cause of a cron task
that runs for weeks and ships nothing, and `/qruns` will show the same failure
from the other end.

## Steps

1. Run it for the current repo. If the user asked about the fleet, use `--all`.
2. Report gaps before notes, and say what each one costs in practice rather than
   restating the check name.
3. Offer to fix — a CLAUDE.md draft from their own recurring constraints, or the
   settings line. Write it on a branch, never straight to main, and never commit
   without being asked.
4. If there are fewer than four other repos, say the baseline is too thin before
   anything else. The tool already flags this; do not bury it.
