# Megarepo Store GC — Glossary

Domain language for store garbage collection, specifically the reclamation of
cold named-branch worktrees. Scope: `mr store gc` and the store liveness model.

## Language

**Cold worktree**:
A store worktree that no workspace is currently using AND that has been
continuously absent from every workspace live set for the grace window. Cold is
the precondition for reclamation. Opposite: **hot** (recently touched or live).
_Avoid_: stale (reserve that for the merge/age signal), unused.

**Live set**:
The union of store worktree paths recorded as in-use by all registered
workspaces, read from the **liveness registry**. The hard cross-megarepo veto:
a path in the live set is never deleted.
_Avoid_: in-use set, active set.

**Liveness registry**:
The store-local cache at `$STORE/.state/workspaces/<hash>.json`, one record per
workspace, listing that workspace's `livePaths`. A cache, not an authoritative
index: a workspace contributes only after running an `mr` command that refreshes
its record.

**Cross-megarepo veto**:
The rule that membership of a worktree in ANY workspace's live set forbids its
deletion, even if it independently looks reclaimable. Protects shared store
worktrees consumed by other megarepos.

**Lossless floor**:
The non-negotiable precondition that deleting a worktree loses nothing
irreplaceable: every local commit is reachable on a remote, and any uncommitted
state has been captured (archived) first. Distinct from staleness — the floor is
about safety, staleness about timing.

**Staleness**:
Positive evidence that a worktree's work is done. Primary signal: the branch's
GitHub **PR is merged**. Absence of merged evidence is not staleness — it means
"keep". Not derivable from `git` ancestry here because the repos squash-merge.

**Grace window**:
The minimum duration a worktree must be continuously absent from all live sets
(and otherwise reclaimable) before it becomes cold. A buffer against deleting a
worktree a consumer simply hasn't re-registered recently.

**Archive (as trash)**:
The recoverable holding area at `<repo>/.archive/<name>/`, an existing
worktree-archive convention reused as gc's capture-then-delete mechanism.
Reclamation is two-phase:
a cold+stale+lossless worktree is **archived** (recoverable), then **reaped**
(hard-deleted) once the archive ages past its retention TTL.
_Avoid_: trash, recycle bin (use **archive** for the on-disk concept).

**Reap**:
Hard-delete of an archived worktree past its retention TTL — the step that
actually reclaims disk. Distinct from **archive** (the recoverable first step).

## Flagged ambiguities

- **stale** vs **cold**: in prior informal usage "stale" meant both "old/merged"
  and "safe to delete". Resolved: **staleness** = the merged/done signal only;
  **cold** = the full deletion-eligibility state (not-live + grace window +
  lossless + stale).
- **`--all` mode** is NOT "delete everything stale" — it is the protection-
  bypassing nuclear mode that ignores the live set entirely. Cold reclamation is
  a separate, live-set-honoring path within default gc.
