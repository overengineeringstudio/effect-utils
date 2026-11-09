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

## Lock-scope attribution

Lock scopes accept `agent/<nonempty>`, `unit/<name>.service` (1–240 ASCII
letters, digits, `@ : . _ -` in the name), and `launchd/<label>` (1–240 ASCII
letters, digits, `. _ -`, starting with a letter or digit). `run` requires valid
attribution for exclusive acquisition. `validate-inherited`, `reap`, and `guard`
accept optional `--agent`; all use `WORKTREE_LEASE_AGENT` as its environment
default. Invalid supplied actors fail closed on these validation/maintenance
commands. Existing unattributed callers of those commands remain supported.

Attribution is not authentication: labels do not establish a caller's identity
or permissions, and never replace kernel lock or record-evidence checks.
Persistent schema-1 records remain **agent-only** for both creator and holder:
`create`, `renew`, `gate-lease.json`, and compatibility record writers reject
service actors. No schema migration or additional record format is introduced.

## Orphaned linked admin directories

`guard --orphan-admin <common>/worktrees/<name> --agent unit/maintenance.service`
checks an orphan without requiring a live worktree backlink. Unlike
`guard --git-dir <admin>`, it refuses a live linked worktree. The admin must
resolve directly below the common directory's real `worktrees` directory;
symlink aliases and containment escapes are rejected. Regular `commondir` and
`gitdir` files must identify that common directory and an absolute worktree
`.git` path. The target must be absent or have a `.git` file that demonstrably
does not link back; unreadable or ambiguous state is refused.

Only the backlink requirement is relaxed. The same `gate-lease.lock`,
`gate-lease.json`, retention markers, expiry, host, namespace, and process-death
checks apply, with identity revalidation around acquisition and record reads.
A held lock returns `Busy`. Reattaching the worktree invalidates the orphan
identity. This mode does not authorize deleting the worktree path.

Like normal `guard`, the CLI returns an eligibility snapshot, not continuing
authority after it exits. Rust callers performing mutation must retain the
`guard::reclaim_orphan` lease through the operation, then drop it.

### Scoped orphan mutation

`run --mode exclusive --orphan-admin <common>/worktrees/<name> --try
--agent unit/maintenance.service -- <command>` retains the same exclusive fence
through the payload, which may delete the admin directory inside that scope.
`--orphan-admin` conflicts with the positional worktree and rejects shared mode.
Use `--await <seconds>` instead of `--try` to wait for the fence.
All orphan resolver, retention, and record-evidence checks above apply, with
identity and evidence revalidated under the lock before starting the payload.

For this mode, `WORKTREE_LEASE_WORKTREE` contains the **canonical admin directory
path**, not the missing worktree path from `gitdir`. `WORKTREE_LEASE_LOCK_FD`
still names the inherited exclusive descriptor. Nested commands use
`run --mode exclusive --inherited --orphan-admin <admin>
--agent unit/maintenance.service -- <command>` or
`validate-inherited --orphan-admin <admin> --lock-fd <n>`. Both validate the same
orphan identity and evidence, fail closed on reattachment or a foreign fence,
and must run before the payload deletes the admin directory. Environment values
alone never authorize mutation, nor does this scope authorize deleting the
former worktree path.
