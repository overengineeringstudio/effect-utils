# Reuse Spec

This document specifies the client contract for the shared cache and the
verification of reuse claims. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** client wiring, executor configuration, and reuse verification.

**Does not define:** service deployment (dotfiles#2009), consumer admission
sequencing (effect-utils#1054), or remote execution (deferred; see roadmap).

## Client Contract

```ini
# tracked buckconfig: the repository's trust tier, read-only (decision 0033);
# -c CLI overrides do not reach the RE client
[buck2]
digest_algorithms = SHA256
allow_cache_uploads = false
[buck2_re_client]
engine_address = grpc://<tier-host>:<port>
action_cache_address = grpc://<tier-host>:<port>
cas_address = grpc://<tier-host>:<port>
instance_name = <repo-name>
tls = <true for the public tier>
```

Public effect-utils uses the public tier. A protected publisher holding
`BUCK2_CACHE_WRITE_BASIC_AUTH` gets an untracked `.buckconfig.local` overlay
(`scripts/buck2-cache-posture.ts`) that sets `allow_cache_uploads = true`,
`default_allow_cache_upload = true`, and
`http_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH`. Buck
expands the variable in the daemon, so no credential value is written to a file.

Executor platforms set `remote_enabled = False` and read `remote_cache_enabled`
and `allow_cache_uploads` from the root config (cache-only: local execution,
remote reuse). Disable toggle: pointing the client section away (or removing
it) restores pure-local builds — documented as the outage escape hatch
(REUSE-R04).

## Reuse Verification

Reuse claims are verified from Buck-native evidence (cache-hit classes in the
build report and event log), not from wall-clock inference:

1. Populate: build an admitted target in context A.
2. Wipe: `buck2 kill` and remove `buck-out` in context B (second worktree or
   second machine, same platform, same revision).
3. Rebuild in B: assert zero locally executed actions for unchanged targets
   (REUSE-R02); investigate any miss as a key regression using action-digest
   comparison from the event log.

The same procedure at the composition boundary (standalone root vs composed
root) guards decision 0014's identity claim. Budget measurements (REUSE-R03)
run on a quiet host or record load context; contention-dominated numbers are
not regressions.
