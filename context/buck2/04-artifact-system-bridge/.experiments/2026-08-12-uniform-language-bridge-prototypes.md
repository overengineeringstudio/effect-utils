# Uniform TypeScript and Rust Bridge Prototypes

## Status

Completed on 2026-08-12. The shared architecture survived the prototypes, but
production admission remains blocked on contract hardening and real language
products.

## Question

Can TypeScript and Rust converge on one Buck-to-Nix product bridge without
language-specific importers, and should Rust remain the first implementation
sequence?

## Method

Independent read-only lanes inspected the real Buck graph, TypeScript closure
compiler, artifact exporter/importer, Nix source builders, CI platform matrix,
and retained Rust products. Disposable controls exercised relevant and
unrelated pnpm graph mutations, hostile-environment packaging, platform and ABI
rejection, descriptor identity, native ELF inspection, evidence joins, and
rollout deletion boundaries.

Fresh heavy builds stopped when the host filesystem reached capacity. Those
cases are recorded as no-verdict rather than semantic failures.

## Result

The shared language-neutral envelope survived, but every current implementation
surface remains prototype or stage-0. The controls below define the contract
hardening and real-product gates required before authority transfer.

## Current Reality

| Surface                                              | Result |
| ---------------------------------------------------- | -----: |
| Generated package-local BUCK files                   |      1 |
| Real TypeScript compile/test/executable Buck targets |      0 |
| Real Rust Buck targets                               |      0 |
| TypeScript Nix source builders                       |      7 |
| Rust Nix source builders                             |      2 |
| Production/system artifact-import consumers          |      0 |

The existing `tui-core` target packages a non-authoritative TypeScript input
plan. The existing bridge imports a synthetic portable fixture. These are
working prototypes, not production TS/Rust convergence.

## TypeScript Closure Controls

| Control                                                 | Result                                           |
| ------------------------------------------------------- | ------------------------------------------------ |
| Warm `tui-core` input-plan build                        | 4.213 s, zero actions                            |
| Unreachable real-lock integrity mutation                | Plan bytes and simulated closure identity stable |
| Reachable native-package integrity mutation             | Plan and simulated closure identity changed      |
| Plan computation                                        | 2.288-7.961 ms                                   |
| Closure computation                                     | 2.825-3.521 ms                                   |
| Packager under empty environment without `node_modules` | Byte-identical output                            |

The identity control used resolution-derived placeholder payload identities
because verified normalized pnpm package artifacts do not exist in Buck yet.
It is model evidence, not action-admission evidence. The hostile-environment
control proves packager hermeticity, not TypeScript compiler hermeticity.

## Runtime and Import Controls

| Control                                  | Result                                             |
| ---------------------------------------- | -------------------------------------------------- |
| Wrong target platform                    | Rejected                                           |
| Deliberately wrong declared ELF ABI      | Accepted by current importer; gap                  |
| Unknown runtime/language fields          | Accepted by current importer; gap                  |
| Independent expected descriptor digest   | Not implemented                                    |
| Evidence fixture under empty environment | Executed, but depended on undeclared `/bin/sh`     |
| Nix-built Rust binary                    | 1.34 MB; store-bound; 49.35 MB runtime closure     |
| Preserved Buck Rust binary               | 2.10 MB; no store bytes; local CLI behavior passed |
| Preserved Buck Rust ABI                  | Dynamic glibc through 2.39; not fleet-portable     |
| Static-musl Rust product                 | No-verdict; toolchain/build blocked by disk freeze |

The preserved real Buck descriptor also does not satisfy the current importer's
provenance shape, so a genuine Rust product round trip is unproved. Two equal
preserved archives may be cache copies and do not prove independent rebuild
reproducibility.

## Shared Contract Result

One product envelope remains correct when runtime is a required tagged union:

```text
shared product identity
  |-- interpreter runtime
  |-- ELF dynamic runtime
  |-- Mach-O dynamic runtime
  `-- self-contained runtime
```

The common importer owns strict canonical decoding, independently expected
descriptor and payload identity, archive safety, entrypoints, target platform,
and semantic provenance policy. Small runtime backends own inspection,
compatibility, realization, and re-inspection. No field depends on whether the
producer source was TypeScript or Rust.

Implementation provenance must move out of product identity. A control changed
only `provenance.producer` and changed the current descriptor digest despite
equal payload bytes, contradicting the intended semantic boundary.

## Observability Result

No bridge receipt is needed. One evidence envelope can join native Buck, Nix,
and system records using descriptor digest and generation identities. The
current E2E emits only a human-readable pass line, importer outputs are not
rooted, and no activation/health implementation exists. One observed imported
fixture disappeared during inspection because `--no-link` left it eligible for
garbage collection.

## Conclusion

Retain the uniform architecture and Rust-first implementation sequence, but
insert contract hardening before authority transfer. First make the common
descriptor strict, externally pinned, runtime-tagged, and evidence-joinable.
Then build and publish one real Rust CLI for one exact platform tuple. Apply the
same bridge to TypeScript only after its Buck graph materializes verified pnpm
packages and runs a real compiler or executable action.

Do not add language-specific importers, projected Cargo locks, publication
databases, source-build fallbacks, or a second receipt schema. Delete each legacy
source route only after its exact package/platform replacement passes import,
rollback, health, and independent conformance controls.

## VRS Impact

Refines the artifact-system bridge specification with a required runtime tagged
union, semantic/evidence provenance separation, descriptor-digest joins, and a
contract-hardening gate before the shared Rust-first admission sequence.
