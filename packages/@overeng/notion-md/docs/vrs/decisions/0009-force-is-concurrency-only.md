# `--force` bypasses only the concurrency guard, not correctness guards

> **Refined by [0017](./0017-edit-is-an-ephemeral-file-engine-session.md).** The
> exit-6 schema-drift guard below is now the engine's `schema_snapshot`
> comparison (the stateless in-buffer fingerprint it originally referenced was
> deleted with decision 0013). The visible-placeholder consequence is historical
> (decision 0010, superseded by 0016). The principle — `--force` is
> concurrency-only — stands.

`put --force` (and `edit --force`) bypasses **only** the exit-7 base-hash guard
(`NotionMdBodyConflictError`) — the last-writer-wins concurrency escape. It does
**not** override the exit-3 lossy refusal or the exit-6 schema-drift refusal.

Those are correctness guards, not concurrency: pushing a lossy body can delete
content the user never saw (R12), and writing properties against a drifted
schema can corrupt typed data (R14). Neither is about "someone edited
concurrently," so a concurrency override must not silently disable them. Per R15
a destructive mode must report exactly what it bypasses, and `--force` reports
only the guard.

## Status

accepted

## Consequences

- Bypassing lossy/schema-drift requires their own explicit modes, not `--force`.
- Deleting a _visible_ placeholder is normal editing, not a destructive mode at
  all (decision 0010) — so it needs no flag and is unrelated to `--force`.
- Keeps the streaming surface aligned with the vision's "not a last-writer-wins
  backup tool" while still offering a deliberate single-purpose override.
