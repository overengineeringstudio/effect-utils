# Buck2 Dependency-Closure Spec

This document specifies how dependency-materialization identities enter the
Buck semantic graph. It builds on [requirements.md](./requirements.md), the
parent [dependency-materialization requirements](../requirements.md), and the
canonical [Buck semantic-graph contract](../../buck2/01-semantic-graph/spec.md).

## Status

Draft. Historical local evidence exists; authoritative dependency
materialization remains subject to the canonical Buck admission contract.

## Scope

**Defines:** layered external dependency identity, resolver projection,
target-local closure selection, first-party edge separation, and the evidence
needed to join those facts to Buck targets.

**Does not define:** Buck's global authority model, generated package intent,
language execution, toolchains, artifacts, Nix import, observability, cache
trust, or admission. Those are owned by [`context/buck2`](../../buck2/).

## Requirement Trace

| Section                        | Requirements     |
| ------------------------------ | ---------------- |
| Identity join and authority    | DMP.BUCK-R01-R04 |
| Closure record and consumption | DMP.BUCK-R05-R09 |
| Verification                   | DMP.BUCK-R10     |

## Identity Join

```text
resolver-selected package payload
              |
              v
       PackageContentId
              |
resolver context + selected edges
              v
       PackageContextId
              |
LogicalTargetId + CapabilityRequirement[] + platforms
              v
         TaskClosureId
              |
              v
semantic target edge -> declared Buck action inputs
```

`PackageContentId` identifies normalized package bytes plus every patch and
normalization input affecting those bytes. `PackageContextId` adds the complete
resolver-selected dependency context, including peer, feature, optional, and
target-conditioned edges. `TaskClosureId` selects only the contexts and
first-party providers observable by one semantic operation.

The lockfile and repository-wide resolver graph are producer inputs. They are
not automatically action inputs. Equal target-local selected closures yield an
equal `TaskClosureId` even when unrelated lockfile state changes.

## Authority Boundary

| Concern                                        | Authority                                      |
| ---------------------------------------------- | ---------------------------------------------- |
| Requested external dependencies                | Package semantic model and ecosystem manifest  |
| Selected versions, contexts, integrity, fixups | Ecosystem resolver and its faithful projection |
| Normalized immutable dependency bytes          | Authoritative materializer                     |
| Target-local observable roots and capabilities | Buck semantic operation                        |
| First-party dependency topology                | Buck semantic graph                            |
| Action execution and reuse                     | Buck                                           |

The projection compiler may normalize and shard resolver facts. It must not
select a replacement version, omit context that can change resolution, or turn
an unresolved request into an asserted selected edge.

## Closure Record

A closure record is canonical data with this semantic shape:

```ts
interface BuckDependencyClosureV1 {
  readonly schema: 'buck-dependency-closure/v1'
  readonly target: LogicalTargetId
  readonly operationContract: OperationContractId
  readonly taskRole: 'runtime' | 'check' | 'test' | 'tool'
  readonly targetPlatform: string
  readonly executionPlatform: string
  readonly capabilities: readonly CapabilityRequirement[]
  readonly precision:
    | { readonly _tag: 'authoritative-exact' }
    | {
        readonly _tag: 'declared-conservative'
        readonly reason: StableReasonCode
        readonly measurementEvidence: EvidenceRef
      }
  readonly contexts: readonly {
    contextId: string
    contentId: string
    artifactDigest: `sha256:${string}`
    edges: readonly { name: string; targetContextId: string }[]
  }[]
  readonly firstPartyProviders: readonly LogicalTargetId[]
  readonly compilerAbi: string
  readonly closureId: string
}
```

Set-like fields use canonical ordering. Physical storage roots and credentials
are excluded. The closure ID commits to the normalized semantic record,
including precision status, not to its output path or generator executable
location. A declared conservative closure is visible and measurable but cannot
satisfy exact, remote-cache-write, remote-execution, or release admission.

## Projection and Consumption

1. The ecosystem resolver produces selected topology and integrity evidence.
2. The authoritative materializer verifies or creates normalized immutable
   package payloads.
3. The closure compiler joins selected contexts to the operation's declared
   roots, roles, platforms, and capabilities.
4. Genie writes stable package-local closure projections or references under
   the canonical semantic-graph rules.
5. Buck declares the closure record, referenced artifacts, first-party target
   edges, and projection tool as inputs to separate staging and consumer
   actions where those actions have different invalidation boundaries.
6. The consumer runs without ambient package-manager state and fails on any
   missing or extra undeclared dependency access.

## Verification

The proof corpus must cover resolver-specific peer or feature contexts,
patches, aliases, optional and target-conditioned dependencies, workspace
links, non-registry sources, and unsupported source forms. A real repository
target supplements synthetic fixtures.

Required mutation controls are:

| Mutation                              | Expected result                                           |
| ------------------------------------- | --------------------------------------------------------- |
| Relevant selected integrity or edge   | Closure identity changes; exact consumer closure executes |
| Unrelated lock or manifest state      | Closure bytes stable; zero consumer actions               |
| Missing declared edge                 | Projection or isolated consumer fails RED                 |
| Ambient package-manager state removed | Admitted consumer result remains equal                    |
| Exact restoration                     | Original closure and artifact identity return             |

Execution evidence and no-verdict semantics follow
[`context/buck2/05-evidence-verification`](../../buck2/05-evidence-verification/).

## Historical Records

The accepted decisions in [`.decisions/`](./.decisions/) and experiments in
[`.experiments/`](./.experiments/) predate the standalone Buck VRS. They remain
the evidence trail for closure identity and the origin of broader decisions.
Their general build-system conclusions are now normatively owned by the
corresponding `context/buck2` subsystem.

## Open Design Questions

- **DMP.BUCK-DQ1 Resolver-specific context schema:** Which portions of pnpm peer
  contexts and Cargo/Reindeer feature/target topology share a common envelope,
  and which remain resolver-tagged payloads? Resolve with lossless round-trip
  and invalidation controls for both ecosystems; do not force a universal
  optional-field record.
