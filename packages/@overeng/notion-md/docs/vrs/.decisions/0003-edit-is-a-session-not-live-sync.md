# `edit` is a discrete pull-edit-push session, not live/continuous sync

> **Refined by [0017](./0017-edit-is-an-ephemeral-file-engine-session.md):** the
> session shape below is unchanged, but `edit` is now an ephemeral file-engine
> session whose concurrency safety comes from the engine's base-snapshot guard.

`edit` pulls once, opens `$VISUAL`/`$EDITOR` on a `$TMPDIR` temp file, and on
editor exit does one guarded `put`. It is not character-level or continuous
two-way sync, and remote changes do not stream into an open editor.

This is deliberate. Live sync fights a modal editor (cursor jumps, mid-edit
merges), the Notion API is not built for it, and it would require an editor
plugin — which the design explicitly avoids in favor of the canonical
`$EDITOR` integration (the `git commit` / `kubectl edit` / `sudoedit` pattern).
The session model is the accepted interpretation of "two-way editing."

## Status

accepted

## Consequences

- Concurrency safety comes from the guarded `put` (decision 0002), not from
  live reconciliation. A remote change during an editor session surfaces as a
  conflict on save, not as a live buffer update.
- A truly zero-temp-file, in-buffer experience would require an editor plugin;
  that is out of scope and documented as such, not shipped.
