# Archive clean ref-mismatch worktrees in default gc

## Status

accepted; refines decision 0001 for `ref_mismatch` worktrees

## Context

`mr store gc` currently keeps every worktree whose actual checked-out HEAD branch
does not match the branch implied by its store path. That was the right first
default because the store path ref and the actual branch name are conflicting
evidence: deleting or "fixing" either one during GC can lose context.

Fleet dry-runs showed that many mismatches are nevertheless clean, absent from
all live sets, and fully recoverable from remotes. Keeping those forever makes
default GC leave a large class of cold worktrees untouched, while `mr store fix`
is the wrong mechanism for GC because it repairs by checking out the path ref and
mutates the working tree's branch identity.

## Decision

Default `mr store gc` may archive a `ref_mismatch` worktree only on a distinct
clean archival path. It must not use the `store fix` repair behavior.

Eligibility gates:

1. **Dual-ref default guard:** keep when either the store path ref or actual HEAD
   branch is the repo default branch.
2. **Cross-megarepo liveness:** keep when the worktree is present in any
   registered workspace live set, using the same reconcile-all and under-lock
   recheck behavior as decision 0001.
3. **Lossless floor:** require no dirty/untracked work, no unpushed commits, no
   stash, and remote-reachable local commits. A fetch failure keeps every
   worktree for that repo.
4. **Absence grace:** require continuous absence from all live sets for the
   configured absence grace. The first real run with an empty ledger observes but
   does not archive.
5. **Capture:** move the worktree to `.archive/`, record both `pathRef` and
   `actualHeadBranch`, detach the archived worktree, and do not delete either
   branch ref. The archive is reaped only after the normal archive retention TTL.

This path emits `archived` with reason `ref_mismatch_clean` and a `recoverPath`.
Kept mismatches continue to emit reason `ref_mismatch`, with the message naming
the actual HEAD branch and the blocking safety gate when available.

## Consequences

The default GC can reclaim clean branch-alias drift without repairing it and
without treating a branch-name disagreement as proof that either name is
disposable. Disk is freed on archive/reap, while branch-ref cleanup is
intentionally deferred: preserving both names is safer than guessing which ref is
the user's durable intent.

The policy is deliberately narrower than cold named-branch reclamation. It does
not require GitHub PR merged/closed state because the path ref may be stale or
misleading; instead, it requires the stronger clean/lossless floor and absence
grace. Ambiguous work remains kept until a human runs `mr store fix`, checks out
the intended branch, or deletes it explicitly.
