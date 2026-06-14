# Use a single reconcile engine

The v-next implementation has one production reconcile engine: the
frontmatter-dispatched Mirror Sync / Shared Sync engine. The previous
push/pull/sync/status production paths are absent from the current command and
module surface.

## Status

accepted

## Consequences

Watch mode uses the same engine as one-shot sync. Tests describe the current
mechanisms and remove expectations for command shapes that no longer exist.
Versioned `.nmd` schema and explicit source semantics define the accepted file
contract; previous command semantics do not stay alive internally.
