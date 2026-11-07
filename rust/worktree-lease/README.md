# worktree-lease

## Inherited exclusive fences

`run <worktree> --mode exclusive --try --agent agent/example -- <command>`
passes its held lock descriptor only to the payload. The supervisor keeps its
own descriptor close-on-exec; only the post-fork child clears that flag.
`WORKTREE_LEASE_LOCK_FD` names the descriptor and `WORKTREE_LEASE_WORKTREE`
contains the canonical worktree path. Shared runs remove both environment names.

A cooperating nested command uses `run <worktree> --mode exclusive --try
--inherited --agent agent/example -- <command>`. It validates the inherited
exclusive fence against the resolved worktree identity, without acquiring a
second lock. Missing, closed, unlocked, shared, or foreign descriptors fail
closed; there is no fallback acquisition. `validate-inherited <worktree>
--lock-fd <n>` also validates a caller-owned fence. Environment values alone
never confer authority. Nested scopes never unlock the outer fence.

On normal payload completion the outer supervisor explicitly unlocks the open
file description, revoking surviving descendants' duplicates. If the supervisor
is killed abruptly, POSIX flock authority can survive in descendants until all
inherited duplicates close. Linux parent-death protection kills the direct
payload, not its grandchildren; macOS has no parent-death protection. Callers
must supervise descendants and must not treat abrupt supervisor death as
revocation. A payload is trusted not to unlock or transfer its descriptor.
