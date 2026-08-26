# Reuse Requirements

This subsystem owns the shared cache and the reuse criteria. It refines
BUCK-R06 and BUCK-R07. Service deployment authority is dotfiles-owned
(dotfiles#2009); consumer trust sequencing is effect-utils#1054.

## Assumptions

- **REUSE-A01 Cache facts:** The fleet cache is bazel-remote, cache-only, on
  dev3, open read+write inside the tailnet
  ([decision 0013](../.decisions/0013-shared-cache-foundation.md)).
- **REUSE-A02 Disposable state:** CAS and action-cache content is rebuildable
  by definition; wiping or swapping the backend costs a cold period, never
  data.

## Acceptable Tradeoffs

- **REUSE-T01 Local-only exceptions:** Actions whose outputs embed
  machine-local paths (dependency materialization, executor-local projected
  tools) are `local_only` and excluded from remote reuse; their consumers are
  not.

## Requirements

- **REUSE-R01 Remote-first admitted actions:** Every admitted action except
  declared `local_only` exceptions reads and writes the shared action cache
  (`remote_cache_enabled`, `allow_cache_uploads`, `default_allow_cache_upload`).
- **REUSE-R02 Zero re-execution:** A second same-platform context at an
  identical revision re-executes zero actions for unchanged admitted targets.
  Any local re-execution is a key-stability regression and is triaged as a
  defect, not accepted as noise.
- **REUSE-R03 Budgets:** The admitted surface holds the BUCK-R07 budgets: warm
  no-op ≤ 5 s, fresh context with warm cache to green ≤ 3 min. A regression
  blocks admission widening.
- **REUSE-R04 Outage posture:** An unreachable cache is a hard action failure
  in the pinned Buck2. The consumer contract provides a one-line disable
  toggle, and the service is monitored and alerted so an outage is an
  operations event, not a silent slowdown.
- **REUSE-R05 Digest and transport discipline:** SHA256 digests are pinned
  explicitly; the client configuration lives in a buckconfig file (CLI
  overrides do not reach the RE client); batched transfers stay below Buck2's
  4 MiB gRPC client limit, enforced on the client side — bazel-remote
  advertises no batch cap in its Capabilities response, so the server cannot
  enforce this (facebook/buck2#583).
- **REUSE-R06 Shared action cache:** The action cache is shared across
  repositories; `instance_name` is per-repo attribution, not isolation.
  Cross-repo hits are correct by construction and expected under
  megarepo-shared sources. Revocation is a cache wipe (REUSE-A02).
- **REUSE-R07 Output economics:** Cache-uploaded outputs are slim (verdicts,
  dists, descriptors), not staged input trees. Buck-owned local state
  (`buck-out`, isolation dirs) observes BUCK-R08: no per-invocation isolation
  dirs, stale state reclaimed (`buck2 clean --stale`).
