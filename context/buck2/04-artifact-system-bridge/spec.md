# Artifact and System Bridge Spec

This document specifies the verified Buck-to-Nix build-product boundary and
the handoff into Nix-managed system generations. It builds on
[requirements.md](./requirements.md).

Status: **Draft**. The generic archive and import seam has prototype evidence.
No TypeScript or Rust executable, publication flow, or system generation is
admitted through the bridge yet.

## Scope

This subsystem owns one direction only: a Buck-produced repository build enters
Nix as verified immutable bytes and is then composed by Home Manager, NixOS, or
nix-darwin. Nix-to-Buck execution tools belong exclusively to
[02-execution-platforms](../02-execution-platforms/spec.md). Evidence envelopes
belong to [05-evidence-verification](../05-evidence-verification/spec.md), and
admission belongs to [06-admission-reuse](../06-admission-reuse/spec.md).

It does not define repository graphs, tool descriptors, cache services, fleet
configuration, credentials, evidence verdicts, or admission records.

## Requirement Trace

| Section                | Requirements        |
| ---------------------- | ------------------- |
| Authorities and flow   | BUCK.BRIDGE-R01-R04 |
| Build-product contract | BUCK.BRIDGE-R05-R13 |
| System handoff         | BUCK.BRIDGE-R14-R16 |

## Authorities and Flow

```text
Buck action authority
  -> normalized build payload + build-product descriptor
  -> Nix expected-value verification and immutable import
  -> runtime realization
  -> Home Manager | NixOS | nix-darwin generation
  -> activation transaction
  -> independent health observation
```

| Concern                                                        | Authority                          |
| -------------------------------------------------------------- | ---------------------------------- |
| Repository target graph, compilation, normalization, packaging | Buck2                              |
| Expected product identity and import policy                    | Nix configuration                  |
| Verification and immutable import                              | Nix builder                        |
| Runtime libraries, wrappers, services, generation              | Nix module system                  |
| Activation and rollback                                        | Home Manager, NixOS, or nix-darwin |
| Runtime health                                                 | Declared service observer          |

No consumer may infer permission to perform an upstream authority's operation.
Nix may transform runtime representation but must not compile repository source.

## Build-Product Contract

There is one logical `buck-build-product/v1` descriptor:

```text
buck-build-product/v1
  schema and semantic contract
  payload digest, size, and normalized format
  declared entrypoints
  target platform and runtime ABI
  result-affecting provenance
```

The descriptor carries a required runtime tagged union. Runtime behavior is a
product property rather than a source-language property:

```text
RuntimeContract =
  | Interpreter { runtimeId, runtimeContract, program }
  | ElfDynamic { machine, loaderClass, neededLibraries,
                 symbolVersionFloors, runpathPolicy }
  | MachODynamic { architecture, minimumOs, dylibs,
                   installNamePolicy, rpathPolicy, signingPolicy }
  | SelfContained { inspectionContract }
```

The shared importer has no TypeScript or Rust branches. It strictly validates
the common envelope and dispatches runtime inspection and realization to the
selected tagged backend. A product with multiple runtime kinds is split rather
than represented by a universal optional-field record.

Canonical encoding and archive normalization are versioned parts of the
contract. Paths are safe repository-relative paths. Archives have stable member
order, ownership, timestamps, modes, and explicit resource limits. Verification
rejects digest or size mismatch, unknown fields, duplicate or escaping paths,
file/ancestor collisions, unsupported node types, undeclared entrypoints,
trailing data, and platform or ABI mismatch.

Semantic provenance that changes the declared product contract or bytes enters
descriptor identity. Implementation provenance such as helper language,
checkout location, native Buck invocation/action identity, or generator binary
identity belongs in the evidence envelope. It must not perturb product identity
when the normalized payload and semantic contract are equal.

## Verified Import

Expected values arrive from Nix configuration independently of the product:

```text
expected descriptor digest
+ expected payload digest
+ expected semantic contract
+ expected target platform and entrypoints
+ provenance policy
```

Import is fail closed:

1. Verify and strictly decode the descriptor against the external expectation.
2. Verify payload digest and size before archive parsing.
3. Pre-scan the complete archive against canonical and resource constraints.
4. Extract into a fresh owned root and inspect entrypoints and runtime ABI.
5. Produce an immutable normalized import.
6. If runtime relocation or signing is required, derive and re-inspect a
   separate realized output.
7. Emit an evidence record through the evidence subsystem and expose only the
   verified realized output to system composition.

The caller supplies the digest of the canonical descriptor bytes independently
of the descriptor. Unknown fields and runtime variants fail strict decoding.
`portable` is not a synonym for a script or source archive: an interpreter-based
product names the exact runtime contract that Nix supplies and wraps.

For Linux dynamic artifacts, realization supplies declared loaders and
libraries, then rechecks interpreter, runtime paths, dependencies,
architecture, and symbol-version floors. For Darwin artifacts, realization
normalizes install names and runtime paths, applies declared signing policy,
then rechecks architecture, minimum OS, dependencies, runtime paths, and
signature state. Portable artifacts remain unmodified and contain no
undeclared host or Nix-store dependencies.

## Admission Sequence

```text
strict shared contract
  -> real execution platforms and toolchains
  -> one real Rust CLI on one Linux target tuple
  -> immutable publication and reviewed Nix pin
  -> import, composition, rollback, and health proof
  -> second Rust CLI and remaining target tuples
  -> real TypeScript executable through the same envelope
  -> second-repository conformance
```

Rust is the first implementation sequence because it exercises the harder
native-runtime boundary. This does not create a Rust-specific terminal bridge.
TypeScript and Rust converge on the same envelope and importer after their
language adapters produce exact closures and normalized products.

Nix source builds remain explicit stage-0 or reference producers until a
package/platform cell is admitted. After authority switches, the covered source
builder, dependency-preparation route, and implicit fallback are deleted. Buck,
Genie/projection bootstrap, and the launcher retain narrow stage-0 exceptions
until separate replacement evidence avoids a bootstrap cycle.

## System Handoff

```text
verified immutable import
  -> declarative package, wrapper, and service bindings
  -> composed generation
  -> activation or rollback
  -> independent health observation
```

Bindings contain product and policy identities, not secrets or fleet-private
values. Activation is an atomic generation transaction and preserves its known
predecessor until rollback policy allows collection. Built, verified, imported,
realized, composed, activated, rolled back, and observed healthy are distinct
states. They are joined by evidence references but never collapsed into one
success flag.

## Cross-Repository Conformance

Repositories may instantiate the same build-product, verification, and system
handoff contracts while owning their own target graphs and private Nix modules.
General reuse is not claimed until a second independently owned repository
passes conformance through public contracts. The extraction location remains
an open root-level design question until that proof exists.

Public and private writers retain separate writable cache authority. Compatible
consumers may share verified immutable bytes without sharing write credentials
or private topology.

## Evidence Boundary

Buck event logs and build reports remain execution authority; Nix derivation
and store records remain import and composition authority; system and service
manager records remain activation and health authority. This subsystem emits
references to those records through the evidence contract. It does not define a
second receipt or verdict schema.

One evidence envelope joins native records by canonical descriptor digest from
Buck build through Nix import and system composition, then by generation and
predecessor-generation identity through activation, health, and rollback. It
records references and phase dispositions, not duplicate Buck, Nix, or service
facts. Trace and span IDs are query conveniences rather than durable identity.

The minimum phase vocabulary is `buck.build`, `artifact.import`,
`system.compose`, `system.activate`, `service.health`, and `system.rollback`.
High-cardinality digests, invocation IDs, derivation/store paths, generation
IDs, and private target names stay out of metric labels.
