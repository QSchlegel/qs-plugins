# Operating notes

## Known gaps

- **`collab_event` grows without bound.** No retention policy. Add one before a real
  tenant, or the live-sync table becomes the largest thing in the database.
- **No rate limiting** on any endpoint. Fine for a single-tenant prototype, not for a
  public host.
- **Ephemeral signing key** unless `ED25519_PRIVATE_PEM` is set; `/healthz` reports
  `ephemeral_key: true` so this is visible rather than silent.
- **Vault bodies are never uploaded**, only titles, tags and outbound link names. If that
  ever changes it is a material privacy decision, not an optimisation.
- **`wrote_ok` is not delivery.** It is a tool-result observation. No filesystem probe
  runs server-side, and the field name must not start claiming otherwise.

## Invariants worth a test before each release

1. `assertPlaneSeparation()` still throws on a `collab_* → finding` foreign key.
2. A contribution containing an unknown field is rejected by name.
3. The k-gate suppresses and *counts*; suppression is never silent.
4. A task cannot be accepted by someone it was not offered to.
5. An illegal task transition (`draft → done`) is refused.

All five have been exercised by hand; none is automated yet. That is the first thing to
fix if this goes multi-tenant.
