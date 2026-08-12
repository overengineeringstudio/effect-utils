# Artifact and System Bridge Spec

This document specifies the verified Buck-to-Nix build-product boundary and
the handoff into Nix-managed system generations. It builds on
[requirements.md](./requirements.md).

Status: **Draft**. The exact descriptor validator and canonical identity are
implemented, and the generic archive/import seam plus OCI protocol have
prototype evidence. The importer rejects every runtime because no runtime
inspector is admitted yet. No TypeScript or Rust executable, publication flow,
or system generation is admitted through the bridge.

## Scope

This subsystem owns one direction only: a Buck-produced repository build enters
Nix as verified immutable bytes and is then composed by Home Manager, NixOS, or
nix-darwin. Nix-to-Buck execution tools belong exclusively to
[02-execution-platforms](../02-execution-platforms/spec.md). Evidence envelopes
belong to [05-evidence-verification](../05-evidence-verification/spec.md), and
admission belongs to [06-admission-reuse](../06-admission-reuse/spec.md).

It does not define repository graphs, tool descriptors, registry deployment,
fleet configuration, credentials, evidence verdicts, or admission records.

## Requirement Trace

| Section                | Requirements        |
| ---------------------- | ------------------- |
| Authorities and flow   | BUCK.BRIDGE-R01-R04 |
| Build-product contract | BUCK.BRIDGE-R05-R13 |
| System handoff         | BUCK.BRIDGE-R14-R16 |
| Publication boundary   | BUCK.BRIDGE-R17-R22 |

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

There is one logical `buck-build-product/v1` descriptor. The exact common
envelope is:

```json
{
  "schema": "buck-build-product/v1",
  "name": "otel-scrape",
  "platform": {
    "os": "linux",
    "architecture": "x86_64",
    "abi": "musl"
  },
  "payload": {
    "file": "artifact.tar",
    "format": "tar",
    "digest": {
      "algorithm": "sha256",
      "sri": "sha256-..."
    },
    "sizeBytes": 123
  },
  "entrypoints": ["bin/otel-scrape"],
  "runtime": {
    "kind": "self-contained",
    "inspectionContract": "elf-static/v1"
  },
  "semanticProvenance": {
    "target": "//packages/@overeng/otel-scrape:product",
    "recipe": "otel-scrape/v1",
    "toolchain": "rust-linux-musl/v1"
  }
}
```

All listed records are exact: missing and unknown fields fail. The canonical
descriptor bytes are UTF-8 `builtins.toJSON` output with no trailing newline;
their external identity is `sha256:<lowercase-hex>`. Payload identity remains
the SHA-256 SRI digest of `artifact.tar` and is therefore distinct from
descriptor identity.

The descriptor carries a required runtime tagged union. Runtime behavior is a
product property rather than a source-language property:

```text
RuntimeContract =
  | interpreter { runtimeId, runtimeContract, program }
  | elf-dynamic { machine, loaderClass, neededLibraries,
                  symbolVersionFloors, runpathPolicy }
  | mach-o-dynamic { architecture, minimumOs, dylibs,
                     installNamePolicy, rpathPolicy, signingPolicy }
  | self-contained { inspectionContract }
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

Semantic provenance is the exact `target`, `recipe`, and `toolchain` contract
that changes the declared product meaning and therefore enters descriptor
identity. Implementation provenance such as helper language, checkout
location, source revision used only for attribution, native Buck
invocation/action identity, or generator binary identity belongs in the
evidence envelope. Evidence fields are unknown descriptor fields and fail exact
validation. Evidence must not perturb product identity when the normalized
payload and semantic contract are equal.

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

The caller supplies the `sha256:<lowercase-hex>` digest of the canonical
descriptor bytes independently of the descriptor. Unknown fields and runtime
variants fail strict decoding. A recognized runtime tag is still not import
admission: the importer fails until the selected runtime inspector exists.
`portable` is not a synonym for a script or source archive: an interpreter-based
product names the exact runtime contract that Nix supplies and wraps.

For Linux dynamic artifacts, realization supplies declared loaders and
libraries, then rechecks interpreter, runtime paths, dependencies,
architecture, and symbol-version floors. For Darwin artifacts, realization
normalizes install names and runtime paths, applies declared signing policy,
then rechecks architecture, minimum OS, dependencies, runtime paths, and
signature state. Portable artifacts remain unmodified and contain no
undeclared host or Nix-store dependencies.

## OCI Publication Boundary

```text
Buck product + descriptor + evidence
                 |
                 v
       sealed admission bundle
                 |
       +---------+---------+
       |                   |
       v                   v
 OCI storage A       OCI storage B
 independent pull    independent pull
       +---------+---------+
                 |
                 v
 third encrypted archive -> restore proof
                 |
                 v
 reviewed Nix exact child-manifest pin
                 |
                 v
 fixed-output fetch -> verified import -> offline activation/rollback
```

OCI is the transport and retention protocol, not an identity oracle. A product
may publish a multi-platform OCI index for discovery, but deployment review
selects and pins the exact child manifest. OCI's platform fields do not encode
the complete runtime ABI contract, so a consumer must verify the child against
the product descriptor rather than auto-selecting the first matching platform.
Tags are convenience aliases only and never enter an expected-value contract.

The relevant identities remain distinct:

| Identity                      | Meaning                                      | Authority                    |
| ----------------------------- | -------------------------------------------- | ---------------------------- |
| Buck action digest            | Declared execution result                    | Buck native evidence         |
| Product descriptor digest     | Canonical semantic product contract          | Buck producer + caller check |
| Payload digest                | Normalized product bytes                     | Product descriptor           |
| OCI child-manifest digest     | Exact transport graph for one product tuple  | Reviewed Nix pin             |
| OCI index digest              | Optional multi-platform discovery aggregate  | Discovery only               |
| Sealed-bundle digest          | Complete admission evidence membership       | Admission publication        |
| Nix derivation/store identity | Imported and system-composed realization     | Nix                          |
| System generation identity    | Activatable configuration and rollback point | System manager               |

### Sealed admission bundle

Referrers may aid discovery but do not prove that all required evidence was
present when admission was evaluated. The publisher first creates a canonical
unsigned `buck-admission-subject/v1`:

```json
{
  "schema": "buck-admission-subject/v1",
  "productDescriptorDigest": "sha256:...",
  "payloadDigest": "sha256:...",
  "ociChildManifestDigest": "sha256:...",
  "targetPlatform": "x86_64-linux",
  "runtimeAbi": "glibc-dynamic",
  "members": {
    "sbom": "sha256:...",
    "provenance": "sha256:...",
    "evidenceEnvelope": "sha256:..."
  }
}
```

The detached signature signs the canonical subject digest. A second canonical
root then seals the subject and signature without a digest cycle:

```json
{
  "schema": "buck-admission-bundle/v1",
  "subjectDigest": "sha256:...",
  "signatureDigest": "sha256:...",
  "signatureContract": "sigstore-bundle/v1"
}
```

Every subject member is mandatory according to the named admission policy. The
canonical outer bundle digest is the completeness root pinned by the consumer;
the signature proves the inner subject digest, and the outer bundle binds that
exact signature to that exact subject. Adding or replacing a member, subject,
or signature creates a new outer root. Mutable referrer listings cannot
silently widen the admitted bundle.

### Publication and durability sequence

1. Push the complete digest-addressed OCI graph to the primary storage
   instance.
2. Copy the complete graph to an independently readable storage instance.
3. Pull by digest from each instance using separate read paths and verify every
   manifest, blob, descriptor, bundle member, and signature.
4. Export the complete graph into a third encrypted failure-domain archive,
   restore it into an empty verifier, and repeat the same digest checks.
5. Advance reviewed Nix configuration to the exact child-manifest and sealed
   bundle digests only after all three observations pass.

Replication completion, tag listing, registry health, and blob existence are
insufficient substitutes for independent full-graph reads. Storage endpoints,
credentials, hostnames, and physical placement remain downstream private
configuration and never enter public product identity.

Deletion and registry garbage collection remain disabled initially. Later
collection derives its live set from reviewed Nix pins, retained system
generations, and their complete sealed bundles; emits a dry-run plan; snapshots
the candidate sweep; deletes only unreachable objects; and proves restore from
that snapshot before collection is admitted. A replica is not a backup.

### Offline system lifecycle

Registry access is permitted only in the fixed-output fetch/import derivation.
After that derivation enters the Nix store, system composition, activation,
rollback, and runtime startup consume store objects only. A network-disabled
activation and rollback control is mandatory; an unavailable registry must not
change the result for an already imported generation.

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
