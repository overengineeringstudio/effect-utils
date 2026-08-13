# Buck2 Repository Build Spec

This document specifies the portable Buck kernel and its repository and Nix
boundaries. It builds on [requirements.md](./requirements.md).

## Status

Draft.

## Scope

**Defines:** authority, component ownership, dependency direction, the public
kernel boundary, and subsystem composition.

**Does not define:** a consumer's dependency resolver, CI topology, artifact
transport, deployment, activation, rollback, health, or rollout plan.

## Architecture

```text
public kernel                         repository adapter
  schemas + rules <------------------ semantic intent + policy
  executors + evidence adapters <---- dependency projections
          |                                  |
          +--------------+-------------------+
                         v
                  configured Buck graph
                         |
               declared deterministic work
                         v
            native evidence + BuildProduct
                    |              |
                    |              v
                    |       independent Nix import
                    |              |
                    v              v
              caller-owned task trace and system realization
```

The kernel is portable source code and versioned contracts. A repository
adapter binds those contracts to repository-local labels, sources, dependency
projections, aliases, and policy. A consumer invokes Buck directly or through
an observational adapter and owns the trace root and every live effect.

## Authority Matrix

| Concern                                       | Authority                                         | Boundary                                       |
| --------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Repository semantic intent and private policy | Repository adapter                                | Versioned kernel input                         |
| Dependency selection                          | Ecosystem resolver or declared repository adapter | Immutable closure projection                   |
| Repository-local deterministic work           | Buck                                              | Providers, configured platforms, action keys   |
| Tools and system inputs                       | Nix                                               | Immutable executable and data providers        |
| Portable artifact                             | Buck                                              | `buck-build-product/v1` descriptor and payload |
| Product validation and store import           | Nix                                               | Exact descriptor and payload checks            |
| Task trace, retention, and admission decision | Calling control plane                             | W3C context, native evidence links, verdict    |
| Deployment and all live effects               | Consumer                                          | Outside the public Buck contract               |

## Invocation Flow

```text
1. control plane starts task span and passes W3C context
2. repository adapter selects an admitted Buck label and platform tuple
3. Buck analyzes and executes using declared providers
4. control plane, optionally aided by an adapter, records native evidence
5. Buck returns its native result and, when requested, a BuildProduct
6. Nix independently validates and imports the BuildProduct
7. control plane records evidence, product, import, and admission outcome
```

Buck's result is determined at step 5. Export, retention, or import failures are
separate outcomes and never rewrite it. Product publication or live operation,
when needed, begins after this flow under consumer-owned requirements.

## Public Kernel

The portable kernel may contain:

- semantic graph, operation, and native-evidence schemas;
- Starlark rules and providers;
- platform and executable-provider contracts;
- deterministic support executors;
- `BuildProduct` validation fixtures;
- Buck evidence decoders and OpenTelemetry semantic bindings;
- cross-repository conformance fixtures.

It must not contain repository paths, private labels, fleet names, endpoints,
secrets, activation policy, or a central list of consumer targets.

## Observation Boundary

Direct invocation of the pinned Buck binary plus native build evidence is the
baseline. The calling control plane owns the task and invocation spans,
retention, sampling, routing, sanitization, and admission verdict. Evidence may
be decoded after execution without interposing on Buck.

An execution-transparent observer is justified only when a measured requirement
cannot be met by the caller and post-execution native-evidence adapter. The
current TypeScript launcher is transitional; a Rust replacement is a candidate,
not a required architecture. Before any wrapper replaces it, conformance must
prove passthrough, cancellation, evidence, sanitization, and telemetry parity.
No launcher receipt is a durable authority unless an independent consumer is
specified.

## Forbidden Edges

- Kernel code must not depend on a consumer repository.
- Buck actions must not evaluate Nix, run a package-manager install, or mutate
  consumer live state.
- Nix import must not invoke Buck or fall back to a repository source build.
- An observer must not select targets, platforms, aliases, or policy.
- Telemetry must not supersede native Buck evidence or change Buck's result.
- A `BuildProduct` must not encode transport, activation, rollback, or health
  state.

## Requirement Trace

| Requirements                           | Refinement                |
| -------------------------------------- | ------------------------- |
| BUCK-R05 through BUCK-R07              | 01 Semantic Graph         |
| BUCK-R03, BUCK-R05, BUCK-R08           | 02 Execution Platforms    |
| BUCK-R01, BUCK-R02, BUCK-R08           | 03 Target Execution       |
| BUCK-R03, BUCK-R04, BUCK-R09, BUCK-R10 | 04 Artifact/System Bridge |
| BUCK-R11 through BUCK-R15              | 05 Evidence/Verification  |
| BUCK-R16, BUCK-R17                     | 06 Admission/Reuse        |
