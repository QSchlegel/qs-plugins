---
name: qship
description: Turn prompts you keep retyping into slash commands. Pools repeated prompts across every session, separates rituals (a procedure you retype) from misses (a prompt that failed and got re-sent), and writes a .claude/commands file for the ones worth promoting. Use when the user runs /qship, mentions typing the same thing repeatedly, or asks what to turn into a command.
disable-model-invocation: true
---

# qship

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/ship.mjs
node ${CLAUDE_PLUGIN_ROOT}/scripts/ship.mjs --write "ship to preprod"
```

## The distinction that makes this work

A repeated prompt is counted as friction elsewhere, on the assumption the first
attempt failed. About half the time that is wrong.

- **RITUAL** — every instance ran tools and none drew a correction. You are
  hand-typing a procedure. Worth a command.
- **MISS** — the instance ran no tools. Re-sending reproduced the no-op. Worth
  rewriting; a command would just make the wrong thing faster.
- **MIXED** — worked sometimes. Read it before deciding.

Only rituals seen in **two or more sessions** are offered for promotion. Within
one session a repeat is a retry, not a habit.

## Steps

1. Run it. Report the ritual count and the two or three strongest candidates
   with their session counts — not the whole list.
2. For anything the user picks, run `--write`. It creates a branch-ready file
   under `.claude/commands/` and refuses to overwrite.
3. **Never commit it for them.** Show the path, say it is a starting point taken
   from what they typed, and let them edit before it lands.
4. For misses, show the prompt and what happened after it. The useful output is
   "this ran nothing twice", not a suggestion.

## Rules

- Machine text is filtered — skill preambles and sleep-resume notices are not
  prompts anyone typed. If something obviously mechanical still appears, say so
  rather than offering to promote it.
- Do not invent a better wording for a ritual. The value is that it is exactly
  what the user types; a rewritten version is a different command they will not
  remember.
