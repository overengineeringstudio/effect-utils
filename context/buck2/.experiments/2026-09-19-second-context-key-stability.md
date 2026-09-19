# Second-context key stability

Date: 2026-09-20
Host: dev3 (x86_64-linux)

## Question

Did the S8 second-context sample expose context-dependent action keys, or did it
run before the shared cache was warm at the sampled revision?

## Method

At pinned revision `948d397a2e`, run exactly two `//:quick` builds through the
shared heavy-command gate, in this order:

1. Run the normal worktree context to populate the shared action cache.
2. Remove the proof worktree's `buck-out` and run the same revision with
   Bubblewrap using `--unshare-all --share-net`, hostname `other-host`, uid/gid
   4242, a fresh `HOME` and `TMPDIR`, read-only Nix store/database and `/etc`,
   and the proof worktree mounted at `/work`.

For each build, capture `buck2 log what-ran --format json
--emit-cache-queries`. Compare the remaining sandbox-local action's action
digest, command, and execution environment against the normal-context action.
The pinned Buck2 does not provide `buck2 audit action-keys`, so the remote action
digest from `what-ran` and `log show` is the action-key evidence.

## Result

Both builds reached the pre-existing `preferSchemaOverJson` warning in
`composition-root-publisher.integration.test.ts`. Tsgo treats the warning as
exit 2, so both builds ended at the same `megarepo:typecheck` action.

| Context | Wall time | Cache queries | Cached | Local | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Normal worktree | 83.1 s | 1,195 | 648 | 547 | Populated the missing cache entries, then stopped at the warning |
| Sandboxed second context | 68.5 s | 1,195 | 1,192 | 1 | Every successful action reused the warmed cache; only the failing typecheck ran locally |

The original six sandbox-local classes reduced to one action in one class:

```text
effect_utils//packages/@overeng/megarepo:typecheck (effect_utils//buck2/platforms:linux_x86_64#a312ca1b0cfd7c35) (tsgo_typecheck typecheck)
```

The normal and sandbox cache queries used the identical action digest:

```text
76ecc7d96ba19cabf193f3e0fc6f48509e214e0b4b1560f75c5dca70c2cf5297:142
```

The command arrays were byte-for-byte equal. Their NUL-delimited SHA-256 was:

```text
4f0a142b51a27f02fb71ddce96ada8870928d8e027d8844570e274180ca75fab
```

No declared action input differed: the equal remote action digest covers the
command and declared input root. `log show` exposed only per-execution values
that Buck does not include in that digest:

```text
normal  TMPDIR=<normal-worktree>/buck-out/v2/tmp/effect_utils/40bdb25f91291859/tsgo_typecheck/typecheck
sandbox TMPDIR=/work/buck-out/v2/tmp/effect_utils/40bdb25f91291859/tsgo_typecheck/typecheck
normal  BUCK2_DAEMON_UUID=305fb556-547b-484d-ac8c-6e1ec2b48dd4
sandbox BUCK2_DAEMON_UUID=3e084141-8c9b-4607-ab1e-ee6d044d1973
normal  BUCK_BUILD_ID=bfb22410-589d-4928-83b2-f4512a96626c
sandbox BUCK_BUILD_ID=5de2112a-3511-4839-85bd-03ceee1c60ec
```

`BUCK_SCRATCH_PATH` was identical and worktree-relative in both runs:

```text
buck-out/v2/tmp/effect_utils/40bdb25f91291859/tsgo_typecheck/typecheck
```

## Conclusion

The 633 local actions in the S8 sandbox sample were a test-ordering artifact.
That sandbox was the first build at its rebased revision. After a normal-context
build warmed the same revision, the sandbox reused every successful action,
including the five previously missed classes other than `tsgo_typecheck`.
There is no context-dependent action-key input in the remaining action: its
digest and command are identical across contexts.

The one remaining local action does not violate key stability. It fails
identically in both contexts, and failed actions do not produce a reusable
successful cache entry. The separate finding is that the
`packages/@overeng/megarepo` `preferSchemaOverJson` warning makes `//:quick`
red on the sampled branch. The landing seat for PRs #1283 and #1301 owns that
finding; this experiment does not fix it.

## VRS Impact

This experiment resolves DELTA-001 as a test-ordering artifact: S8's sandbox
run was the first build at its rebased revision; at one revision with the
normal context warmed first, the sandbox reused 1,192 of 1,195 queried actions,
and the remaining action failed identically in both contexts. DELTA-001 is
removed. BUCK-R06 and REUSE-R02 remain unchanged.
