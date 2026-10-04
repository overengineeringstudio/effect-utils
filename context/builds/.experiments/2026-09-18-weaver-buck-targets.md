# Weaver Buck targets

## Question

Can the bounded Weaver registry and version checks become hermetic Buck actions while the merge-base-relative compatibility check remains outside Buck?

## Method

The root declares `//:weaver_check` and `//:weaver_version_smoke`. The actions receive the Weaver binary and semantic-conventions model through the Nix capability projection. Both targets are members of `//:quick`; `//:all` includes them through `//:quick`.

`weaver:diff` remains a devenv/CI operation because its merge-base input is not bounded by the repository graph. `weaver:live-check` remains a subprocess/network integration operation.

Measurements used the pinned Buck 2026-09-01 binary on Linux x86_64. Local measurements disabled the unavailable authenticated shared-cache client explicitly. Times below are command wall time; Buck's event output supplies action counts.

## Result

| Regime | Result |
| --- | --- |
| Changed action inputs | 1.34 s; 2 local actions; both targets passed |
| Warm unchanged rerun | 0.23 s; 0 actions; passed |
| Fresh daemon, warm local outputs | 8.72 s; 2 local actions; passed |
| Unrelated tracked content edit | 17.43 s including the shared heavy-command gate; 0 actions; passed |
| Hostile registry mutation | `type: definitely_invalid` reran `//:weaver_check` and failed with Weaver's schema diagnostic |
| Focused unit tests | 2 files, 6 tests passed |

The direct warm target cost is below the five-second quick budget, so both targets join `//:quick`.

A fresh-context shared-cache hit rate and CI wall-clock delta remain unavailable locally: this worktree has no SecretSpec provider for `BUCK2_REMOTE_CACHE_BASIC_AUTH`. The local fresh-daemon result is not presented as shared-cache evidence. CI can supply those two R16 fields without weakening the target contract.

## Authority and deletion ledger

| Operation | Disposition | Reason |
| --- | --- | --- |
| `effect-utils/weaver/check` | `buck-owned` | Bounded generated YAML and exact Nix capabilities are declared action inputs. |
| `effect-utils/weaver/version-smoke` | `buck-owned` | Both pin sources and exact Nix capabilities are declared action inputs. |
| `effect-utils/weaver/diff` | `excluded` | The operation depends on a merge-base-relative repository history baseline and is therefore unbounded. |

Deletion entry: remove `nix/devenv-modules/tasks/shared/weaver.nix`, `nix/devenv-modules/tasks/shared/weaver-version-smoke.nix`, their imports, and their `check:all`/CI invocations. The diff and live-check producers remain.

The machinery delta is not net negative in source lines. Two shell-heavy Nix task modules (198 lines) and 12 wiring lines are deleted, but the reusable typed runner, Buck rule, Nix capability bridge, and focused tests are larger. The change removes duplicate producer authority and fail-open behavior, but does not claim a source-line reduction.

## VRS Impact

The two bounded operations satisfy Buck ownership and invalidation requirements. The unbounded compatibility operation stays explicitly excluded. No requirement change is needed.

## Conclusion

Admit both bounded checks to Buck and keep the merge-base-relative diff excluded.
