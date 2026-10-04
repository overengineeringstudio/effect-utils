# Buck2 Repository Build Spec

This document specifies the system architecture and its boundaries. It builds
on [requirements.md](./requirements.md). Subsystem specs own their mechanisms.

## Status

Draft.

## Scope

**Defines:** authority, component ownership, dependency direction, composition
shape, and subsystem responsibilities.

**Does not define:** deployment, activation, rollback, health, CI topology, or
rollout sequencing ([roadmap.md](../.reference/migration-2026/roadmap.md)).

## Architecture

```text
authored intent (genie models, manifests, lockfiles)
        |
        v
01 semantic graph ──projects──> BUCK files + closure descriptors
        |
        v
03 standalone root (.buckconfig: repository cell at .)
        |
        v
configured Buck graph
   |         |          |
   v         v          v
05 execution  04 materialization  ──> actions (typecheck, build, test, package)
(toolchains,  (deps for actions          |
 platforms,    and editor surface)       |
 TS + Rust rules)                        v
                              06 reuse (policy-selected AC/CAS)
                                         |
                                         v
                              native evidence + BuildProduct
                                         |
                                         v
                              distribution / Nix bridge (independent import)
                                         |
                                         v
                              Nix store / system closures (consumer-owned)
```

## Authority Matrix

| Concern                                    | Authority                     | Boundary                                        |
| ------------------------------------------ | ----------------------------- | ----------------------------------------------- |
| Semantic intent, package and target facts  | Genie-composed models         | Projected BUCK files, freshness-gated           |
| Dependency requests                        | Manifests + lockfile          | Only hand-authored dependency input             |
| Dependency materialization (build, editor) | Buck actions                  | `pnpm deploy` from manifests, atomic view flips |
| Repository-local deterministic work        | Buck                          | Providers, configured platforms, action keys    |
| Tools and system inputs                    | Nix                           | Immutable `/nix/store` providers                |
| Cross-repository dependencies              | Published artifacts           | Nix substitution (decision 0037)                |
| Shared reuse                               | Policy-selected remote AC/CAS | REAPI cache-only, tailnet trust                 |
| Portable artifact                          | Buck                          | `buck-build-product/v1` descriptor and payload  |
| Product validation and store import        | Nix                           | Exact descriptor and payload checks             |
| Deployment and all live effects            | Consumer                      | Outside the Buck contract                       |

## Composition Shape

Every build runs from the repository's tracked standalone root: a project root
whose `.buckconfig` declares the repository's canonical cell at `.`, the
bundled prelude, and the Nix-produced capability cell. No tool synthesizes a
cross-repository Buck root; megarepo member mounts are source checkouts, never
cells. An external consumer building a public repository uses the same root
and inhabits its own cache namespace. Mechanism:
[05-composition](./03-consumer-roots/spec.md).

## Invocation Flow

```text
1. genie freshness gate: projections match authored intent
2. the standalone root selects admitted targets and platforms
3. Buck analyzes and executes; unchanged work resolves from the shared cache
4. dependency views flip atomically for the editor surface when manifests changed
5. products cross to Nix through independent import when requested
6. the caller records native evidence; telemetry links to it without replacing it
```

Buck's result is determined at step 3. Export, retention, or import failures
are separate outcomes and never rewrite it. The telemetry lane that links
caller traces to native evidence without replacing it — correlation, the
portable run record, the event-log adapter, trace views, and ingest — is
specified in [07-observability](./07-observability/spec.md).

## Forbidden Edges

- Buck actions must not evaluate Nix, run a package-manager install against
  live state, or mutate consumer live state.
- Nix import must not invoke Buck or fall back to a repository source build.
- Telemetry must not supersede native Buck evidence or change Buck's result.
- A `BuildProduct` must not encode transport, activation, rollback, or health
  state.
- Shared rules and fixtures must not depend on a consumer repository or carry
  private facts (BUILD.AUTH-R14).
- No component interposes a launcher between the caller and Buck
  ([decision 0011](../.decisions/0011-direct-native-evidence-observation.md)).

## Requirement Trace

| Requirements                                   | Refinement                        |
| ---------------------------------------------- | --------------------------------- |
| BUILD.BUCK-R01, BUILD.BUCK-R05                 | 01 Semantic Graph                 |
| BUILD.BUCK-R02, BUILD.BUCK-R04                 | 05 Execution                      |
| BUILD.BUCK-R08, BUILD.BUCK-R11                 | 04 Materialization                |
| BUILD.BUCK-R06, BUILD.BUCK-R07                 | 06 Reuse                          |
| BUILD.BUCK-R05, BUILD.AUTH-R14                 | 03 Consumer Roots                 |
| BUILD.BUCK-R03, BUILD.BUCK-R10                 | Product Distribution / Nix Bridge |
| BUILD.AUTH-R09, BUILD.AUTH-R15, BUILD.AUTH-R16 | 03 Authority: Ledger              |
| BUILD.BUCK-R13 (telemetry lane)                | 07 Observability                  |
| BUILD.AUTH-R12, BUILD.BUCK-R13                 | Root + all subsystems             |

## Shared Foundations

[Identity](../01-identity/spec.md) owns stamps, distinct from action identity.
[Cache descriptors](../02-cache-contract/spec.md) own schema, not writer permission.
[Authority](../03-authority/spec.md) owns the machine-readable ledger and
BUILD.AUTH-R09/R12/R14/R15/R16; this realization consumes it.
[Platforms and toolchains](./02-platforms-toolchains/spec.md) precede roots,
materialization and execution. [Distribution](../05-product-distribution/spec.md)
owns portable products and independent import outside this realization.
