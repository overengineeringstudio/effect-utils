# Archive→restore: retain the trashed observed state across reprojection

Status: proposed

This record closes F8 (decision 0012): a row archived via the public SQLite
surface pushes and applies end to end, but the inverse — restoring that row by
toggling `_in_trash` back to `0` — is not supported, because the archived page
drops out of Notion's data-source query window and the next reprojection rebuilds
the row as `in_trash = 0`.

## The reprojection invariant

`_nds_row.in_trash` is written ONLY by `RowObserved`. In real Notion a trashed
page disappears from `data_source.query`, so it is never re-observed: it becomes
`TombstoneClassified(reason='remote-trash')`, and `_nds_row.in_trash` stays `0`.
After an archive the row therefore reprojects to `in_trash = 0`, and NO
`_in_trash` edit can ever yield a restore — the CDC restore trigger needs a
`1 → 0` transition, and from `0` only an archive (`0 → 1`) is expressible.

## Decision

Retain the TRASHED OBSERVED STATE across reprojection.
`TombstoneClassified(remote-trash)` must reproject the row with `in_trash = 1` —
retain the trashed state, not merely the archive intent — so the trashed row
survives reprojection and a local `_in_trash` `1 → 0` toggle emits `row_restore`.

Do NOT use per-page `pages.retrieve` probing to recover trash state. One API call
per archived page per reprojection scales with the trash set and violates the
efficiency NFR.

Edge (documented fail-closed follow-up, not v1): a page PERMANENTLY deleted in
Notion (past the 30-day trash window) while locally archived. A restore push
would then fail against a page that no longer exists; handle this as a
fail-closed follow-up rather than a v1 guarantee.

## Considered Options

| Option                                                       | Result   | Reason                                                                                                                                                    |
| ------------------------------------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retain the trashed observed state (reproject `in_trash = 1`) | Selected | Keeps the replica self-sufficient and event-log authoritative with zero extra reads; a remote restore self-heals when the row re-enters the query window. |
| Direct per-page trash probe on reprojection                  | Rejected | One API call per archived page per reprojection; rate-limit/latency pressure that scales with the trash set; violates the efficiency NFR.                 |
| Keep archive-only, restore stays a no-op                     | Rejected | Does not close F8; blocks lifecycle restore.                                                                                                              |

A validation trace established the exact reprojection invariant — `_nds_row.in_trash`
is written only by `RowObserved`, and `TombstoneClassified` has no handler that
sets it — and proved via a pure-SQLite probe that from `in_trash = 0` only an
archive (`0 → 1`) is expressible, never a restore.

## Consequences

- `TombstoneClassified(remote-trash)` gains an `in_trash = 1` projection effect.
- Trashed rows remain in the replica as restorable rows rather than vanishing on
  reprojection.
- Cross-reference decision 0014 for the restore guard (`RestorePageCommand`
  through `guardTombstoneSafety`) and the fake-gateway query fidelity that makes
  this testable at the fake level.
- The permanent-delete edge (page deleted past the 30-day trash window while
  locally archived) is a tracked fail-closed follow-up, not a v1 guarantee.
