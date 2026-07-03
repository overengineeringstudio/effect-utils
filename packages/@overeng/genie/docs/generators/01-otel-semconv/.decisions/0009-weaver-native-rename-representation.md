# 0009 — Attribute renames use weaver-native `deprecated: renamed_to`

**Status:** Accepted. Grounds SC-R11 (the `weaver registry diff` compat gate).

## Context

[0003](./0003-unified-full-dotted-keys.md) moves concepts to namespaced keys, so post-1.0
registry evolution will rename attributes. The SC-R11 compat gate uses `weaver registry diff`
to block a breaking registry change from merging. A rename must therefore be _representable_
in the registry in a form the diff reads as graceful, not as a breaking removal.

Two representations were on the table:

- **Weaver-native:** keep the old key in the registry marked
  `deprecated: { reason: renamed, renamed_to: <new> }`; add the new key; delete the old at a
  dated sunset.
- **`deprecatedAlias.was`** (the downstream private consumer's original API sketch): drop the old key, record its
  old name in a non-weaver annotation on the surviving new key.

## Decision

**Renames are recorded weaver-native: retain the old key marked `deprecated: renamed_to` for a
sunset window.** The SC-R11 gate consumes weaver's own `type: "renamed"` classification with no
custom rename-detection logic.

- The gate runs `weaver registry diff --format json` and blocks on `type: "removed"` (and
  diff exit-nonzero from an unresolved ref), passing `type: "renamed"` and `type: "added"`.
- `weaver registry diff` **exits 0 even for breaking changes** — the gate inspects the JSON
  `changes.*[].type` payload, never the exit code.
- The retained deprecated old key is also the attribute that carries the `bridge:` annotation
  ([0004](./0004-metric-label-migration.md)), so the diff-gate representation and the OTTL
  bridge generation key off the same attribute.

This supersedes the `deprecatedAlias.was` shape in the downstream (private) deployment repo; that repo's tracking issue is updated
to the weaver-native representation.

## Rationale (evidence)

See [.experiments/2026-07-03-weaver-rename-diff.md](../.experiments/2026-07-03-weaver-rename-diff.md).
Verified on weaver 0.24.2: representation A yields a dedicated `type: "renamed"`
(`old_name`→`new_name`); representation B yields a breaking `type: "removed"` + unrelated
`type: "added"` that the gate would have to reclassify against an annotation weaver ignores.
The `deprecated: { reason: renamed, renamed_to }` object form is the shape already emitted in
`genie/weaver-registry/attributes.yaml`.

## Scope — not the current PR's migrations

This governs _future_ registry evolution. The first-introduction migrations in this PR
(bare → namespaced) are the initial registry publication: there is no prior published baseline
to diff against, and the bare keys were never registry attributes (historical wire emission),
so they carry no `deprecated: renamed_to` marker. The one live _wire_ break they cause —
`restate_invocations_total`'s bare `service` label, which existing dashboards match — is the
retention-first / OTTL-bridge concern owned by [0004](./0004-metric-label-migration.md) and
realized in the downstream (private) deployment repo, not a diff-gate concern.

## Consequences

- A post-1.0 rename authors two attributes during the window (new canonical + retained
  `deprecated: renamed_to` old), then deletes the old at the dated sunset. Recorded in the
  [version-bump runbook](../version-bump-runbook.md).
- SC-R11 needs no custom rename logic; it is a thin JSON-payload policy over weaver's diff.

## Alternatives rejected

- **`deprecatedAlias.was` (drop old key + out-of-band annotation):** cleaner against 0003's
  "no aliases" but forces the gate to reclassify a weaver-reported breaking removal against an
  annotation weaver does not read. A sunset-dated transitional deprecation is not a permanent
  alias, so 0003 is not violated.
- **Custom rename detection from paired add+remove heuristics:** fragile (pairs the wrong
  add/remove on multi-attribute diffs); weaver already carries the intent when the old key is
  retained.
