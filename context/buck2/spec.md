# Buck2 Repository Build Spec

This document specifies the system-wide authority model and composition of the
Buck2 repository build system. It builds on
[requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** the global authority boundaries, dependency direction, subsystem
composition, state vocabulary, forbidden edges, and cross-repository contract.

**Does not define:** language syntax, package-manager resolution, tool archive
formats, action command lines, CI job names, rollout phases, or current target
inventories. Those belong to subsystem specs or the non-normative roadmap.

## System Structure

```text
first-party intent + ecosystem metadata
                 |
                 v
       +--------------------+--------------------+
       |                    |                    |
       v                    v                    v
01 Semantic Graph   02 Execution Platforms   shared contracts
       |                    |                    |
       +------------+-------+--------------------+
                    |
             product integration join
                    |
                    v
            03 Target Execution
                    |
             normalized result
                    v
       04 Artifact/System Bridge
                 |
      verified Nix realization

05 Evidence/Verification observes every seam
06 Admission/Reuse controls authority expansion and contraction
```

The numbered directories encode documentation and dependency direction where a
dependency exists; they do not require every earlier sibling to depend on the
preceding one. Semantic graph, execution-platform, dependency-materialization,
and shared-contract slices remain independently reviewable foundations. A real
product declares an integration join over only the slices it consumes. A later
subsystem may refine an earlier contract; an earlier subsystem must not depend
on a later realization.

## Authority Matrix

| Concern                                             | Authority                                       | Transfer contract                                                        |
| --------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| Package identity and requested dependencies         | Package semantic source and ecosystem manifests | Versioned semantic graph inputs                                          |
| Selected external dependency topology               | Ecosystem resolver and its declared projection  | Stable resolver-produced labels or closure identities                    |
| Generated first-party Buck topology                 | Genie semantic projection                       | Checked-in deterministic package-local shards                            |
| Repository-local analysis and actions               | Buck                                            | Declared labels, providers, configured platforms, and action keys        |
| Tool recipes, versions, patches, system libraries   | Nix                                             | Current immutable local per-platform tool binding                        |
| Deployable repository artifact                      | Buck after admission                            | Normalized artifact envelope and native evidence                         |
| Artifact transport and retention                    | Untrusted OCI distribution/storage              | Exact digest-addressed OCI graph and sealed admission bundle             |
| Artifact verification and system composition        | Reviewed Nix configuration                      | Exact child-manifest pin, caller expectations, and import receipt        |
| User/system activation and rollback                 | Home Manager, NixOS, or nix-darwin              | Managed generation and activation receipt                                |
| Private aliases, endpoints, secrets, fleet topology | Downstream system repository                    | Runtime-only configuration outside public artifacts and cache identities |

## Directional Flow

```text
Nix tool recipes -----------------------> Buck executable providers
                                                |
semantic graph + dependency projections ------> Buck actions
                                                |
                                                v
                                      normalized Buck artifact
                                                |
                                                v
                                  untrusted OCI transport
                                                |
                                                v
reviewed exact child pin -> Nix verify/import -> runtime composition -> activation
```

No arrow grants authority backward. Normal Nix evaluation, import, or
activation must not start a Buck daemon or inspect a mutable source checkout.
Buck actions must not invoke Nix evaluation or live dependency repair.
Registry location, tags, indexes, and availability do not grant product or
deployment authority. Activation and rollback use already imported Nix store
objects and perform no registry or network access.

## Developer Interface

The development shell owns bootstrap availability, long-lived development
services, secrets, and temporary compatibility aliases. effect-utils owns one
thin generic launcher that forwards caller-supplied Buck arguments to an
already-realized pinned Buck binary. It adds Buck-native report and event-log
flags, retains those artifacts, writes a sanitized receipt, and exposes the
exact underlying invocation. Its current runtime observability is that receipt
and retained Buck evidence; it does not emit OTLP, resolve aliases, select a
configured platform, or claim an exact invalidation cause without a supplied
comparison dimension. Human-facing aliases and platform policy remain in
consumer-owned composition surfaces. After bootstrap the launcher remains
bypassable and must not trigger fresh Nix or devenv evaluation, own target
topology, reinterpret Buck failures, or become a second task graph.

```text
devenv bootstrap/services/secrets
             |
             v
thin bypassable launcher -> realized Buck -> semantic targets
             ^
             |
consumer-owned aliases and private policy
```

Stable semantic target labels are the primary repository interface. Devenv
tasks and downstream aliases are compatibility or composition surfaces that
delegate to those labels and remain owned by their consumer repository.

## State Vocabulary

| State           | Meaning                                                            |
| --------------- | ------------------------------------------------------------------ |
| `declared`      | Semantic graph and every required input/provider are valid         |
| `built`         | Buck reports successful authoritative action results               |
| `published`     | Immutable artifact bytes, envelope, and provenance are retrievable |
| `verified`      | An independent consumer validated pinned expectations and bytes    |
| `imported`      | Nix created a composed output without rebuilding repository source |
| `activated`     | A managed generation committed the imported output                 |
| `observed-live` | A separate runtime observation matched the activated identity      |

Later states imply evidence for earlier states, not semantic equivalence between
them. In particular, `built` is not `activated`, and activation success is not
runtime health.

## Forbidden Edges

- A semantic package declaration must not contain a physical compiler path,
  Nix store path, helper implementation language, or host-derived platform.
- Genie generation must not compile, test, bundle, or inspect compiler-produced
  runtime graphs.
- First-party graph generation must not select third-party versions or rewrite
  resolver fixups.
- An authoritative action must not discover tools through ambient `PATH`, run a
  live package-manager install, or access undeclared workspace state.
- Nix import and system activation must not fall back to a source build.
- Nix-to-Buck stage-0 materialization must not route through the Buck-to-Nix
  product importer; shared transport principles do not reverse subsystem
  authority.
- Evidence aggregation must not replace Buck's native execution authority or
  infer a cause that native and semantic evidence cannot establish.
- Cross-repository reuse must not copy private topology into a public semantic
  graph, artifact, receipt, or cache key.
- A deployment consumer must not infer a platform artifact from an OCI index or
  mutable tag; it consumes the exact reviewed child-manifest digest.
- Buck action-cache records, published OCI products, and Nix binary-cache/store
  objects must not be treated as interchangeable identities or one shared
  cache authority.

## Requirement Trace

| Root requirements         | Owning refinements                             |
| ------------------------- | ---------------------------------------------- |
| BUCK-R01 through BUCK-R06 | 01 Semantic Graph and 03 Target Execution      |
| BUCK-R07 through BUCK-R09 | 02 Execution Platforms and 06 Admission/Reuse  |
| BUCK-R02, BUCK-R03        | 04 Artifact/System Bridge                      |
| BUCK-R10 through BUCK-R12 | 05 Evidence/Verification                       |
| BUCK-R13 through BUCK-R15 | 06 Admission/Reuse                             |
| BUCK-R16                  | Root composition and product integration joins |

## Open Design Questions

- **BUCK-DQ1 Contract ownership:** Which repository and package boundary own the
  shared schemas and conformance tools without creating a bootstrap cycle? OCI
  is the selected artifact transport, not the answer to source ownership.
  Resolve by proving the same pinned contract in a second megarepo and a
  system-configuration consumer.
