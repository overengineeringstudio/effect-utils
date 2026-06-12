# Remove the legacy sync engine

The v-next implementation has one production reconcile engine: the
frontmatter-dispatched Mirror Sync / Shared Sync engine. The previous
push/pull/sync/status production paths are removed rather than preserved as
backwards-compatible shims.

## Status

accepted

## Consequences

Watch mode is ported onto the v-next engine instead of calling the legacy
two-way engine. Tests that describe superseded behavior are rewritten around the
new mechanisms or removed when the behavior no longer exists. Migration is
handled by the versioned `.nmd` schema and explicit source semantics, not by
keeping old command semantics alive internally.
