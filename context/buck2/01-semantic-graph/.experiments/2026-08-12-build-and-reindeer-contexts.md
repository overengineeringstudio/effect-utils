# Build and Reindeer Contexts

## Status

Partial on 2026-08-12. The authority split is established; cross-platform
provider fidelity is not admitted.

## Question

Host/target context belongs to the resolver/execution join, not to the authored
Cargo dependency handle.

## Method

Reindeer commit `e3d72748131d3a70378055f091e0647c1edad85e` and Buck2 Prelude
commit `c9d3fa87f6d191af68a8758d9358959b3cf47fe5` were inspected. Reindeer
`2026.05.04.00` buckified each committed Rust lockfile in a disposable external
directory. Generated aliases, proc-macro rules, build-script warnings, and
build-script-run targets were counted. The probe followed the
[Reindeer manual](https://github.com/facebookincubator/reindeer/blob/main/docs/MANUAL.md).

## Result

| Package       | Cargo packages | Custom-build packages | Proc-macro packages | Unresolved reachable build scripts | Reindeer proc-macro rules | Public aliases | Build-script runs |
| ------------- | -------------: | --------------------: | ------------------: | ---------------------------------: | ------------------------: | -------------: | ----------------: |
| `otel-scrape` |             33 |                     9 |                   1 |                                  7 |                         1 |              5 |                 0 |
| `otelite`     |            224 |                    47 |                  18 |                                 15 |                        10 |              8 |                 0 |

Reindeer omitted build-script execution unless a fixup explicitly selected
`run = true` or `run = false`; its permissive unresolved-fixup default is not a
safe admission mode. Generated proc macros preserve selected target identity,
while Prelude introduces the execution/plugin transition. Prelude documents a
remaining proc-macro alias compromise for target optimization, sanitizer, and
platform constraints.

## Conclusion

An authored handle contains alias, dependency kind, and optional target
predicate only. Selected target/proc-macro identity, public label, and
host/target transitions join later. Admission requires strict unresolved
fixups, explicit execution-platform classification, pinned Reindeer/Prelude,
and Linux/Darwin controls. The current evidence does not admit build scripts or
cross-platform proc-macro execution.

## VRS Impact

Narrows `BUCK.GRAPH.BIND.RUST-DQ5` to the outstanding provider-fidelity and
cross-platform admission proof.
