# session-viz cloud

The hosted side. Everything here is optional — the plugin is fully functional with none of
it running.

```
cloud/
  services/api/   Node service: fleet telemetry (plane A) + collaboration (plane B)
  services/web/   session-viz.com — static landing page and OG image
  infra/          deployment config
  docs/           operating notes
  PRICING.md      pricing model and its assumptions
```

## Two planes, one service, no join

`services/api` serves both planes from one process and one database, and they are kept
apart by structure rather than discipline:

- **Plane A** (`finding`) is person-blind: closed schema, enums and bounded integers only,
  k-gated aggregates, signed reference table.
- **Plane B** (`collab_*`) is identity-bearing on purpose — you cannot hand a task between
  two people without knowing both.

`assertPlaneSeparation()` runs at boot and **refuses to start** if a migration adds a
foreign key between them or gives `finding` an identity column.

## Run locally

```bash
cd services/api && npm install
PORT=8787 ADMIN_TOKEN=a CONTRIB_TOKEN=c COLLAB_TOKEN=k node server.mjs
```

Without `DATABASE_URL` it runs in memory, which is enough for smoke tests.

## Deploy

See `infra/railway.md`. The API is a normal Node service plus Postgres; the web service is
static files. Both currently live in the Railway project `session-viz-fleet`, with
`production` and `staging` environments that have separate databases and separate tokens.

## Environment

| Variable | Plane | Notes |
|---|---|---|
| `DATABASE_URL` | both | Postgres; in-memory fallback when unset |
| `ADMIN_TOKEN` | A | `/admin` dashboard |
| `CONTRIB_TOKEN` | A | `POST /v1/contrib` |
| `COLLAB_TOKEN` | B | vaults, tasks, live sync, MCP |
| `K_GATE` | A | suppression threshold, default 5 |
| `ED25519_PRIVATE_PEM` | A | stable signing key; ephemeral per boot if unset |

Deliberately separate tokens: a machine that ships anonymous telemetry should not thereby
be able to read who is working on what.
