# Decision: Correctness-first experimental admission

## Status

Status: accepted

## Context

Current-round q2–q4 define the evidence needed before product rollout. Loaded-host timing and a weighted generator score can conceal failures of hard constraints.

## Decision

Resolve generator parity, full-width wire correctness, and poisoned-generation reclamation before admitting downstream products. Correctness experiments may run under load; decisive throughput measurements require a quiet runner or an explicitly qualified directional comparison. Generator selection requires all six must-haves, not a weighted winner that misses correctness.

The six gates are zero portable-vector disagreement, extensible semantic codecs on both sides without forking, runtime Effect decoders, deterministic readable output, actionable lossy-input rejection, and a maintained upstream for reused tools. When no existing stack passes, own the compiler.

## Evidence and Argument

[B1](../.experiments/b1-schema-compiler.md) applied the all-gates rule. [B2](../.experiments/b2-integer-wire.md) separated loaded-host correctness from a quiet eight-CPU CI performance run with load 0.15–1.22. [B3](../.experiments/b3-panic-reclamation.md), [R](../.experiments/r-generated-rust.md), and [X](../.experiments/x-binary-bulk.md) retain explicit measurement limits instead of presenting noisy wall times as universal guarantees.

## Options

| Option                                             | Tradeoff                                                 |
| -------------------------------------------------- | -------------------------------------------------------- |
| Evidence gates before product admission (selected) | Avoids rework and false guarantees                       |
| Build first, reconcile later                       | Earlier artifacts, contract churn                        |
| Weighted generator score                           | Always yields a winner even if correctness fails         |
| Policy-tool bakeoffs first                         | Delays interop evidence for an unrelated policy question |

## Consequences

This is an evidence policy, not a dated roadmap. CLI language-policy bakeoffs and experimental language ports are outside this VRS; neutral-IDL research remains separately tracked in [#1547](https://github.com/overengineeringstudio/effect-utils/issues/1547). Neither is an unresolved interop choice.

## Specification

[Runtime admission](../spec.md#runtime-packaging-and-admission-r06-r07-r09) and [schema compiler](../spec.md#schema-ownership-and-semantic-codecs-r02r04-r14).
