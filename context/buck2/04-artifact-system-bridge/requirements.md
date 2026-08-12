# Artifact and System Bridge Requirements

## Context

These requirements define the immutable boundary between Nix-owned tool and
system composition and Buck2-owned repository builds. They refine the parent
[Buck2 requirements](../requirements.md) and, for JavaScript dependency
identity, build on the
[Buck2 evidence requirements](../../dependency-materialization/05-buck2-evidence/requirements.md).

## Assumptions

- **BUCK.BRIDGE-A01 Directional authorities:** Nix owns tool recipes, platform
  runtime composition, and system generations. Buck2 owns admitted
  repository-local action graphs and build outputs.
- **BUCK.BRIDGE-A02 System authority:** Home Manager, NixOS, or nix-darwin owns
  activation and rollback. Importing a Buck2 artifact does not grant Buck2
  system mutation authority.
- **BUCK.BRIDGE-A03 Independent trust:** Artifact content identity, provenance
  policy, cache authority, and activation authority are independent concerns.

## Acceptable Tradeoffs

- **BUCK.BRIDGE-T01 Platform-specific bytes:** Semantically equivalent outputs
  may have different content identities for different target platforms,
  execution platforms, or toolchain policies.

## Requirements

### Must preserve directional authority

- **BUCK.BRIDGE-R01 Nix-to-Buck ownership:** Nix-supplied execution tools cross
  into Buck through the single contract owned by
  [02-execution-platforms](../02-execution-platforms/requirements.md). This
  subsystem must not define another tool descriptor or binding.
- **BUCK.BRIDGE-R02 Buck-to-Nix builds:** An admitted repository build must be
  compiled and packaged by Buck2 exactly once. Nix may verify, import,
  relocate, wrap, and compose the result, but must not rebuild its repository
  sources implicitly.
- **BUCK.BRIDGE-R03 No authority fallback:** A missing or rejected bridge
  artifact must fail closed. Import, activation, or command dispatch must not
  silently substitute a source build or a different artifact.
- **BUCK.BRIDGE-R04 Independent system lifecycle:** Import, system composition,
  activation, rollback, and garbage collection must remain possible without
  reevaluating the Buck2 action graph or rebuilding repository sources.

### Must transfer only verified immutable artifacts

- **BUCK.BRIDGE-R05 Build-product envelope:** Buck-to-Nix build products must
  use one versioned envelope vocabulary for payload digest and size,
  entrypoints, target platform, runtime ABI, and semantic provenance. It must
  not duplicate the execution-tool descriptor.
- **BUCK.BRIDGE-R06 External expectations:** Verification must compare the
  self-described envelope against caller-supplied expectations. An artifact
  cannot establish its own expected identity, platform, kind, or trust policy.
- **BUCK.BRIDGE-R07 Verify before extraction:** Consumers must verify the
  descriptor, expected payload digest, and payload size before parsing or
  extracting archive members.
- **BUCK.BRIDGE-R08 Safe deterministic archive:** Portable archives must have a
  canonical byte representation and bounded extraction behavior. Unsafe paths,
  duplicate entries, ancestor collisions, unsupported node types, escaping
  links, expansion beyond declared limits, and trailing payload data must be
  rejected.
- **BUCK.BRIDGE-R09 Portable means store-independent:** An artifact declared
  portable must contain no Nix store reference or undeclared host runtime
  dependency and must execute through its declared entrypoint with an empty or
  hostile ambient environment.
- **BUCK.BRIDGE-R10 Sensitive-data exclusion:** Public envelopes, payloads, and
  receipts must not contain credentials, private repository facts, fleet
  topology, host-private paths, or undeclared environment values.

### Must make platform and ABI compatibility explicit

- **BUCK.BRIDGE-R11 Exact platform identity:** Target operating system,
  architecture, and ABI family must be explicit and must not be inferred from
  the verification host.
- **BUCK.BRIDGE-R12 Declared runtime ABI:** A native artifact must declare
  whether it is portable or dynamically linked and, when dynamic, the loader
  class, library requirements, and version floors needed to decide runtime
  compatibility.
- **BUCK.BRIDGE-R13 Post-relocation proof:** When Nix injects a loader, search
  path, wrapper, or signing state, it must re-inspect the realized output and
  record the transformation separately from the normalized Buck2 payload.

### Must support declarative system realization

- **BUCK.BRIDGE-R14 Generation composition:** Home Manager, NixOS, and
  nix-darwin must consume a verified imported package through declarative
  generation inputs, wrappers, and service declarations.
- **BUCK.BRIDGE-R15 Atomic reversible activation:** Activation must preserve a
  known predecessor and support rollback without fetching or rebuilding a new
  repository artifact.
- **BUCK.BRIDGE-R16 Separate health:** A generation becoming active and its
  process or service being observed healthy are distinct states with distinct
  evidence.

### Must publish through an untrusted transport

- **BUCK.BRIDGE-R17 Transport is not authority:** OCI distribution and storage
  may retain and transfer immutable products, descriptors, and evidence, but a
  registry, repository name, mutable tag, endpoint, or index must not establish
  expected product identity or deployment authority.
- **BUCK.BRIDGE-R18 Exact child selection:** A deployment input must pin the
  exact OCI child-manifest digest for its target platform and runtime ABI in
  reviewed Nix configuration. It must not rely on first-match or host-selected
  resolution from an OCI index.
- **BUCK.BRIDGE-R19 Sealed admission bundle:** Published admission evidence must
  have one immutable root that binds the exact product descriptor, payload,
  child manifest, SBOM, provenance, signatures, and required evidence digests.
  Referrer discovery alone must not establish bundle completeness.
- **BUCK.BRIDGE-R20 Independent durability proof:** Before a published product
  is production-admitted, its complete OCI graph must be independently fetched
  and verified from two storage instances and restored and reverified from a
  third encrypted failure-domain archive. Replication success without
  independent reads and a restore does not satisfy this requirement.
- **BUCK.BRIDGE-R21 Zero-network lifecycle:** System composition may fetch only
  during the fixed-output import boundary. Activation, rollback, and runtime
  startup must use already imported store objects and perform no registry or
  network access.
- **BUCK.BRIDGE-R22 Conservative collection:** Published graphs and admission
  bundles must remain undeletable until collection derives a complete live set
  from reviewed pins and retained rollback states, previews the sweep, preserves
  a restorable snapshot, and proves restoration after collection.
