# Lifecycle (trash-state) divergence is a first-class conflict

Status: proposed

Page trash-state — the lifecycle surface where SQLite `_in_trash` mirrors the
remote trash — is a bidirectional surface, so it falls under XC-R02 ("No silent
last-writer-wins for any bidirectional surface"). Divergent local/remote
lifecycle is therefore CONFLICT-DETECTED, not silently resolved. This record
decides the three mechanisms that realize that.

## Decision

**`in_trash` converges from three sources.** ADR 0015 set `in_trash` from the
remote-trash tombstone only. It is extended to converge from three sources:
`RowObserved` (remote active state), `TombstoneRecorded(reason='remote_trash')`
(remote-initiated trash), AND `RemoteWriteSettled` for a SETTLED local
archive/restore intent. The settled-local-intent source is what makes the LOCAL
archive↔restore round-trip behave identically on one-shot AND watch, and it
clears `in_trash` and the tombstone on a settled restore — closing two gaps M2a
left open: a stale `in_trash = 1` after a successful restore (a real correctness
bug) and F8 never engaging on the watch incremental path. It costs zero extra
API calls, since the settled intent is already known, honoring EFF-R01.

**Wire the declared-but-unwired `PendingIntentShadowViolation` guard.** Today
this is only a `GuardName` literal at `core/guards.ts:49`, with no production
dispatch. A remote lifecycle observation (`RowObserved`) that would OVERWRITE a
pending — or settled-but-remotely-diverged — local lifecycle target state is
BLOCKED and raised as a conflict, instead of silently flipping `in_trash`. This
is the guard already designed for exactly this case ("a remote observation would
overwrite pending local target state").

**Add a `lifecycle` `ConflictKind`.** Alongside `same-property`,
`body-body-delegated`, `delete-vs-edit`, and the rest in `core/conflicts.ts`,
add a `lifecycle` kind with detection, projection into
`_nds_replica_conflicts`, and a resolution path (keep-local / keep-remote)
symmetric to property conflicts.

The post-settlement case that motivates this: a local archive SETTLES (remote
trashed), then someone independently RESTORES the page in Notion. The next
sync's `RowObserved` sees the row active and would silently flip `_in_trash`
back to `0`, overriding the user's archive intent. Push-time guards
(`StaleSurfaceBase`, and F5 `ReadAfterWriteMismatch` at settlement) already
catch IN-FLIGHT divergence, but not this post-settlement remote change — that is
the silent LWW XC-R02 forbids.

## Considered Options

| Option                                                                                                      | Result   | Reason                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content-preserving LWW exception (projection follows the latest authoritative lifecycle event; no conflict) | Rejected | A trash-toggle is content-preserving, so it does not violate XC-R04, but silently overriding the user's archive/restore INTENT on remote divergence is exactly the silent LWW XC-R02 (canonical) forbids for a bidirectional surface. |
| Guard at push only + latest-observation projection                                                          | Rejected | Catches divergence only while a local change is in-flight; a fully-settled-then-remotely-changed toggle still silently follows remote.                                                                                                |
| Conflict-detect via the shadow guard + a `lifecycle` ConflictKind                                           | Selected | Honors XC-R02 uniformly, realizes the already-designed `PendingIntentShadowViolation`, and the settled-intent `in_trash` convergence simultaneously closes the M2a stale-after-restore bug and the watch-path gap.                    |

A code trace established that `_in_trash` is written only by `RowObserved` and
(M2a) `TombstoneRecorded(remote_trash)`; that `ConflictKind` has no lifecycle
member; that `PendingIntentShadowViolation` is declared-but-unwired
(`guards.ts:49` only); and that `DeleteVsEdit` covers trash-vs-property-edit,
not pure archive↔restore divergence. The M2a agent itself filed the
stale-after-restore and watch-path gaps on epic #698.

## Consequences

- `PendingIntentShadowViolation` is realized and leaves the
  reserved/placeholder set.
- A `lifecycle` `ConflictKind` plus its resolution path is added.
- ADR 0015's tombstone-only `in_trash` projection is augmented with
  settled-intent convergence, closing the stale-after-restore correctness bug
  and the watch local round-trip.
- Remote-INITIATED trash on the watch path still relies on watch's periodic full
  reconcile (VERIFY-R06), not the incremental scan.
- This is the correct realization of REPLICA-R12 and XC-R02, so it needs no
  re-ratification.
- Cross-reference decisions 0014 and 0015.
