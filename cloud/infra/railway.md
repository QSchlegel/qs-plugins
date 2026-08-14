# Railway deployment

Project `session-viz-fleet` (`6716466c-812c-4d6d-8e95-df06361cf00b`).

| Environment | API | Database |
|---|---|---|
| production | `session-viz-fleet-production.up.railway.app` | own Postgres |
| staging | `session-viz-fleet-staging.up.railway.app` | own Postgres |

Environments were created with `railway environment create staging --duplicate production`,
so the `DATABASE_URL = ${{Postgres.DATABASE_URL}}` reference carries over and resolves
*within* each environment. That is what makes them genuine isolation planes rather than
two views of one database — verified by staging reporting `findings: 0` on first boot
while production still held its own rows.

## Deploy

```bash
cd cloud/services/api
railway up --service session-viz-fleet --environment staging --detach
railway deployment list --service session-viz-fleet --environment staging --json
```

Never report a deploy as done on `up` returning — that only means the build was queued.
Poll until `status` is `SUCCESS`.

## Domains

| Host | Service | Purpose |
|---|---|---|
| `session-viz.com` | `session-viz-web` | landing page |
| `cloud.session-viz.com` | `session-viz-fleet` | API, auth, MCP |

Both are attached and awaiting DNS. Railway issues certificates only after it can
verify ownership, so until the records below resolve the domains return a certificate
error while the `*.up.railway.app` hostnames keep working.

At the registrar, add per domain:

1. the **CNAME** Railway shows for that domain in the dashboard
   (Service → Settings → Networking → the domain row), and
2. the ownership **TXT** record:

```
_railway-verify.cloud.session-viz.com  TXT  railway-verify=af1d474a7469e79f6fbb5912a6573b6bfd858ffef916553cd0d5018c945cfdd3
_railway-verify.session-viz.com        TXT  railway-verify=ab6370d88418a33d9828260dc58d23e43ebb55eb389217384d46ddb4d3bba869
```

The apex (`session-viz.com`) needs a provider that supports CNAME flattening —
ALIAS/ANAME at Cloudflare, or an A record to the address Railway shows. A plain CNAME
at the apex is invalid DNS.

**These two hosts must stay on the same registrable domain.** `RP_ID` is
`session-viz.com`, so a passkey enrolled on the landing page is valid for the API
subdomain. Moving the API to a different domain breaks every existing passkey.

## Before production

- [ ] Set `ED25519_PRIVATE_PEM` per environment. Ephemeral keys rotate the reference-table
      signature on every restart, which makes the signature tamper-evidence only.
- [x] Point `session-viz.com` at the web service — attached, DNS pending.
- [ ] Confirm `og.png` resolves absolutely once DNS is live (social scrapers do not
      follow relative paths).
- [ ] Configure an email provider. Until then OTP codes are printed to the service log,
      which is fine for a single operator and wrong for customers.
- [ ] Decide retention for `collab_event`; it grows without bound today.
- [ ] Rate-limit `POST /v1/contrib` and `/v1/mcp`.
