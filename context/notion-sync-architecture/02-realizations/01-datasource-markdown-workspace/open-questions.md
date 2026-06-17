# Notion DB Markdown Sync Open Questions

These are unresolved design or verification gaps left after ratifying the
decision log. They are not accepted decisions.

## OQ1 — Dry-run coverage for object and body materialization surfaces

The dry-run suppression mechanism covers object/attachment storage and `.nmd`
body materialization, but no current fixture makes those surfaces observable
under dry-run. Add fixtures that prove those surfaces stay unchanged under
`sync --dry-run` and that the corresponding non-dry path is non-vacuous.

## OQ2 — Real settlement verdict for shared-mode property proof

The shared-mode settlement proof field is plumbed through the planner property
proof path, but production currently defaults it to present. Wire the real
outbox settlement verdict into the proof so `ReadAfterWriteMismatch` is driven by
production data, not only by tests.

## OQ3 — Declared traceability scenarios without executable tests

Some traceability scenarios remain declared against `docs/vrs/spec.md` rather
than a concrete executable test because the daemon timing context, relation and
rollup fixtures, soak harnesses, or live provisioner lanes are not yet available.
Repoint each scenario to an executable test as its mechanism or fixture becomes
available.

## OQ4 — Permanent delete after local archive

If a page is permanently deleted in Notion after being locally archived, a later
local restore should fail closed with a specific guard and repair path. The v1
archive/restore decision retains trashed state without probing each archived page,
so this edge needs its own fail-closed design.
