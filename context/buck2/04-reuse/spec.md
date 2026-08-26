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
# buckconfig FILE (repo .buckconfig or untracked .buckconfig.local);
# -c CLI overrides do not reach the RE client
[buck2]
digest_algorithms = SHA256
default_allow_cache_upload = true
[buck2_re_client]
engine_address = grpc://<dev3-tailnet-host>:<port>
action_cache_address = grpc://<dev3-tailnet-host>:<port>
cas_address = grpc://<dev3-tailnet-host>:<port>
instance_name = <repo-name>
tls = false
```

Executor platforms set `remote_enabled = False`, `remote_cache_enabled = True`,
`allow_cache_uploads = True` (cache-only: local execution, remote reuse).
Disable toggle: pointing the client section away (or removing it) restores
pure-local builds — documented as the outage escape hatch (REUSE-R04).

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
