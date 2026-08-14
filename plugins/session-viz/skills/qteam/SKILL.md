---
name: qteam
description: Work with the shared session-viz cloud — federated Obsidian vaults across projects and people, and task handoff between teammates. Resolve a [[wikilink]] against every vault you can see, find links that resolve nowhere, hand a task to a colleague with the context they need, or list what has been handed to you. Use when the user runs /qteam, mentions handing work over, asks who else has notes on something, or wants to find a concept documented in another project's vault.
disable-model-invocation: true
---

# qteam

The collaboration half of session-viz. Everything here goes through the hosted
MCP server, so it needs configuration the local commands do not.

## Before anything

The MCP tools appear as `mcp__session-viz__*`. If they are absent the server is
not configured — say so plainly rather than guessing:

```bash
export SESSION_VIZ_TOKEN=…      # from Sign in at session-viz.com, or COLLAB_TOKEN when self-hosted
export SESSION_VIZ_ACTOR=you@company.com
export SESSION_VIZ_URL=https://cloud.session-viz.com   # or your own deployment
```

Then restart the session — MCP servers connect at start-up.

## What it can do

**`vault_register`** — index a vault. Send paths, titles, tags and outbound link
names only. **Never send note bodies.** The server has a column for them and it
stays null; the moment a body leaves the machine this stops being a local-first
tool. Build the index by walking `*.md` for frontmatter and `[[wikilinks]]`.

**`vault_resolve`** — resolve a link across every registered vault, returning
*all* candidates with an `obsidian://` URI each. When `ambiguous` is true, show
the choices and let the user pick. Do not pick for them: silently choosing one
of three notes with the same title is how a knowledge graph starts lying.

**`vault_dangling`** — links that resolve to nothing in any vault. Useful after a
merge or a rename. Report the count before the list; most of the value is in
whether it is 3 or 300.

**`task_create` / `task_offer` / `task_accept` / `task_done` / `task_list`** —
handoff. A task moves `draft → offered → accepted → done`. It becomes someone
else's only when they accept, and the server enforces that — never describe a
task as "assigned" while it is merely offered.

**`events_recent`** — what has happened lately, the same stream `/v1/live` pushes.

## Writing a handoff brief

The brief is the whole point, and a bad one wastes the recipient's first twenty
minutes. Include:

- what was being attempted, and why that rather than something else
- what has already been ruled out, with the evidence
- the exact repo, branch and worktree
- what "done" looks like

No secrets, and no wholesale transcript excerpts. If the session that produced
the work is worth reading, name it — the recipient can open it locally.

`/qpact` on the session being handed over is the best source for all of this:
its intent breakdown and open threads are already the right shape.

## Steps

1. Confirm the MCP tools are present. If not, stop and give the configuration above.
2. Do the smallest useful thing that was asked. This skill is a set of verbs, not
   a report generator — do not render HTML unless asked.
3. State what changed in one or two lines, including anything the server refused
   and why: an offer to someone outside the tenant, an illegal transition, an
   ambiguous link. Those refusals are information, not errors to paper over.
