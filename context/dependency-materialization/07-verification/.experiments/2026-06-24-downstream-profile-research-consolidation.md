# 2026-06-24: Downstream Profile Research Consolidation

This file records non-normative evidence for dependency materialization
verification. Normative behavior lives in [../spec.md](../spec.md).

## Question

The downstream pnpm/Nix/Buck2 research package can be retired once every durable
finding is represented in effect-utils as a VRS requirement, spec rule,
fixture/proof, benchmark shape, pending evidence marker, or explicit rejection.

## Method

The imported research is preserved in this tree:

- [downstream-dependency-profile-research.md](../.research/downstream-dependency-profile-research.md)
- [proof-catalog.md](../.research/proof-catalog.md)

## Result

The research package contains durable proof categories:

- split shared-files-pool prune failure;
- store-status false-clean evidence;
- guard, doctor, and repair decision models;
- synthetic and real-workload store-trait benchmarks;
- profile evidence determinism;
- topology planning and Nix CLI profile evidence;
- FOD freshness decisions;
- native lifecycle, native binding, and source-build probes;
- CI job-local isolation;
- low-disk skip records;
- Buck2 clean-root and profile evidence.

Those categories map to existing effect-utils DMP subsystems:

| Durable category                       | Owning VRS surface                                         |
| -------------------------------------- | ---------------------------------------------------------- |
| shared-store prune/status/repair       | [04-store-authority](../../04-store-authority/spec.md)     |
| prepared FOD freshness and hash proof  | [03-nix-prepared-deps](../../03-nix-prepared-deps/spec.md) |
| Buck2 clean-root/profile evidence      | [Buck repository build](../../../buck2/spec.md)            |
| benchmarks, skips, and proof taxonomy  | [07-verification](../spec.md)                              |
| build-log and machine-readable records | [06-observability](../../06-observability/spec.md)         |

## Conclusion

The reusable long-term shape belongs in effect-utils as verification
requirements, fixtures, proof harnesses, benchmark records, and pending
evidence markers. The downstream branch no longer needs to remain a parallel
VRS source of truth once its production-relevant findings are represented here.

The imported registry-backed all-root repair conclusion is superseded for the
whole Store Cache realization. Its split-files-pool corruption proof remains
valid; current repair keeps graphs root-local and delegates whole-cache lifecycle
to the package manager under the cache-owner boundary.

## VRS Impact

- The split-pool failure remains negative evidence for DMP.STORE-R03 and
  DMP.STORE-R16.
- Current Store Cache lifecycle and repair semantics live in
  [04-store-authority](../../04-store-authority/spec.md) and decision 0006.
- Historical named live profiles, raw shared-CAS language, root registries, and
  coordinated all-root repair are not current normative architecture.
