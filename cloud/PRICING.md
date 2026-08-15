# Pricing model

Working document. **Every number below is a starting hypothesis, not a decision** — the
unit and the shape are the considered parts; the figures need your margin targets and at
least a handful of real conversations before they go on a page.

## The unit: an agent-run

Priced per **agent-run**, not per seat. Three reasons, in order of how much they matter:

1. **Per-seat requires counting people.** The telemetry plane is built so that no query
   can resolve to a person. Billing per seat would reintroduce exactly the identity join
   that `assertPlaneSeparation()` exists to forbid. The pricing model has to respect the
   architecture or the architecture is theatre.
2. **A run is what the product measures.** Every screen in the console is keyed on runs.
   Customers can predict the bill from the same number they are already watching.
3. **It prices the thing that is growing.** On the reference corpus, subagents were 94% of
   runs and ~99% of autonomous spend. Seats were flat; runs were not.

A **run** = one transcript with a terminal state: a human session, a scheduled run, a
subagent, or a workflow agent. It is the `run` row in the spine. Countable, auditable by
the customer against their own local parse, and impossible to inflate silently.

## Tiers

### RYO — free, MIT, self-hosted

Everything local: both plugin commands, the control center, every gate, and the backend
deployable to the customer's own infrastructure. Nothing is held back or crippled.

This is not a funnel trick. The parser and the statistical gates **are** the credibility;
a closed parser producing numbers nobody can reproduce would destroy the one thing that
distinguishes this from a vanity dashboard. It also means the free tier is a permanent
recruiting ground for the only asset that matters — the reference table.

Costs us: docs, issue triage, and the parser tracking a format that moved 12 times in 60
days. That last one is the real expense and it is the thing the paid tiers fund.

### Fleet — hosted, usage-based

| | |
|---|---|
| Included | 50,000 runs / month |
| Overage | €0.0004 / run (≈ €0.40 per 1,000) |
| Floor | €49 / month |
| Annual | −15% |

Sanity check against the reference corpus: 1,166 runs in 60 days ≈ 583/month, comfortably
inside the floor. A 20-developer team at that rate is ~12k runs/month — still the floor.
A team running heavy fan-out workflows (one session spawned 347 children) reaches 50k
quickly, which is the intended shape: **the bill tracks agent volume, and agent volume is
what the product is for.**

What the money buys: managed Postgres and backups, the federated vault index, task
handoff, live sync, a hosted MCP endpoint, a signed reference table with a stable key,
EU region, DPA, deletion on request.

What it does not buy: a person column. That is not a tier.

### Support — annual, scoped

Starting at **€6,000 / year**, scoped per engagement.

- Named contact with a response-time commitment
- Deployment review and upgrade assistance
- **Extraction contract pinned to the customer's CLI versions** — the highest-value item
- Co-determination pack: what is measured, what structurally cannot be, in a form a works
  council can read
- Custom detectors for their recurring tasks
- Priority on parser fixes when the format moves

Sold mainly to organisations that must clear a works council before deploying anything
that touches developer activity. For them the compliance artefact is worth more than the
software, and it is cheap for us to produce because the architecture already makes the
argument.

## Why these numbers, and where they are weak

**The overage rate** is anchored on being visibly small next to model spend. A run that
consumes ~1M cache-read tokens costs the customer far more in inference than in
observability; if that ratio ever inverts, the price is wrong.

**The floor** exists because a 600-run/month solo user costs us more in Postgres than
€0.24 would cover. It is also the honest place to say: below this, use RYO.

**Weakest assumption:** that customers will accept a metered bill for observability at
all. Many budget for it as a flat platform cost. If discovery says that, switch the Fleet
tier to flat-rate bands by run volume (0–50k, 50–250k, 250k+) and keep the unit for
internal reporting. Same unit, different packaging — that change is cheap.

**Do not** introduce a per-seat tier "because enterprises ask for it." The answer is that
the product cannot count seats, and that is the feature they are buying.

## Sequencing

1. Ship RYO and the landing page. Measure installs and which commands get run.
2. Open Fleet as a private beta at the floor price only. No overage until the metering is
   reconciled against a customer's own local count.
3. Sell Support to the first organisation that asks about works councils — that question
   is the qualifying signal.
4. Revisit the rate once ten tenants exist. Not before; three data points would produce a
   confident number with no denominator, which this project does not do.
