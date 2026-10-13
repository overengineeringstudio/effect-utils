# Data graph API design and executable spike

Status: proposed Effect 4 API; sequential filesystem spike, not a production scheduler.
TypeScript + Effect is intentional: this is a consumer-supplied Effect execution contract
and JS-runtime adapter over the existing content-address engine, not a second byte engine.

## Concepts and public surface

A `NodeDef` is a template. Its branded non-empty `kind` and consumer-chosen canonical JSON
`scope` identify an instance. The graph never interprets scope. `NodeKey` optionally selects
an output; `NodeId` is the canonical JSON string of **only** `{ kind, scope }`. The corresponding
existing `ContentDigest` supplies storage names. Output names do not change node identity.

Every node declares named outputs with independent `ContentDescriptor`s and static named
input references binding exactly one upstream output. `value`, `evidence`, or explicit
freshness metadata are ordinary separate channels, not graph special cases. Dependencies
may be computed from scope but must be stable declared topology, never discovered by the
executor. A run resolves each instance once and fails on cycles or conflicting definitions
for a kind. Dependency names and manifest entries are sorted by code-unit order.

```ts
import { Context, Effect, Layer, Schema } from 'effect'
import type { ContentDescriptor, ContentDigest } from '@overeng/content-address'

// Actual schemas and full types are exported from src/mod.ts.
type NodeKey = { kind: NodeKind; scope: Schema.Json; output?: string }
type Recipe = { kind: NodeKind; version: string; config: Schema.Json }
type Execution =
  | { _tag: 'Accepted'; outputs: Readonly<Record<string, OutputBytes>>;
      receipts: ReadonlyArray<ContentDescriptor> }
  | { _tag: 'Rejected'; reason: string; receipts: ReadonlyArray<ContentDescriptor> }
type NodeDef = {
  _tag: 'Derive' | 'Observe'
  kind: NodeKind
  outputs: ReadonlyArray<string>
  recipe: (scope: Schema.Json) => Recipe
  inputs: (scope: Schema.Json) => Readonly<Record<string, NodeRef>>
  execute: (context: { scope: Schema.Json;
    inputs: Readonly<Record<string, ContentDescriptor>> }) =>
    Effect.Effect<Execution, GraphExecutionError | ContentAddressError | Schema.SchemaError, GraphStore>
}
// Consumer services are closed over or supplied with Effect.provide before registration.
DataGraph.ref(node: NodeDef, scope: Schema.Json, output: string): NodeRef
DataGraph.nodeId(key: NodeKey): string
DataGraph.nodeIdDigest(key: NodeKey): ContentDigest
DataGraph.materialize(ref: NodeRef, options?: { refresh?: ReadonlyArray<string> }):
  Effect.Effect<MaterializeResult, GraphFailure, GraphStore>
DataGraph.getHead(key: NodeKey): Effect.Effect<Option.Option<Head>, GraphFailure, GraphStore>
GraphStore.fileSystem(root: string): Layer.Layer<GraphStore>
writeJson(schema, value): Effect.Effect<ContentDescriptor, ContentAddressError, GraphStore>
DataGraph.isStale(head: Head, now: number, maxAge: number): boolean
DataGraph.planRefresh({ now, heads, policy, budget }): ReadonlyArray<RefreshRequest>
```

`OutputBytes` contains bytes, media type, optional codec/schema version. `GraphStore` is a
`Context.Service` of `put/get/manifest/pin/lookup` operations. The filesystem layer directly
reuses `makeFileSystemContentStore`, `putBytes`, `getBytes`, `putManifest`, `pinManifest`, and
`getPinnedManifestDescriptor`; `ContentPin` remains the only pin grammar. Canonical JSON and
descriptors come from `canonicalJsonBytes`, `canonicalJsonString`, and
`descriptorForCanonicalJson`, not a second serializer/hash implementation. The optional
content-address byte-engine service remains honored by the underlying CAS operations.

A result contains selected output, all output descriptors, materialization descriptor,
node identity, outcome, and a dependency-first per-run trace. Outcomes are tagged:
`Reused`, `Executed { changedOutputs }`, and
`Rejected { attempt }` (with an existing selected head). A failed execution propagates its
structured error after storing an attempt. No selected observation plus rejection/failure
cannot supply a downstream value. The spike deliberately validates output names at runtime;
a future typed-output definition builder would be API ergonomics, not different semantics.

## Action identity and early cutoffs

Recipe version means implementation/schema/canonicalizer version, **never a timestamp**.
Config contains every behavior-changing configuration, including template/policy digests.
If execution depends on scope beyond named inputs, the recipe must include that dependency
in config; scope is not implicitly an ActionKey component. Equal recipes and inputs may
share actions across scopes only when the consumer guarantees equal behavior.

An ActionKey is the digest of a canonical `ContentManifest` role `data-graph.action`,
with a recipe-object descriptor (role `recipe`) and each input-output descriptor
(role `input`, logical path = dependency name). There is no `createdAt`. Output identity is
separate: the descriptor of that output's bytes, not of the action or provenance manifest.

`materialize` resolves/validates upstream selections before considering a deterministic
cache hit. For `Derive`, identical ActionKey reuses the accepted materialization and never
calls the executor. Otherwise it executes and compares each output digest with the previous
selected head. A changed input may rerun `extract` while its `value` stays equal; consumers
of `value` retain their action keys. An evidence-only change reruns `gate` but not
`render-en`/`render-de`. These are the action-cache and output early cutoffs respectively.

Historical heads retain their original output set across recipe upgrades. Comparing a
new execution reads that historical map independently of the current contract; added and
removed names count as changed, while overlapping names compare digests. Current cache
hits still require an exact match with the current declared output set.

Input/output descriptor maps have no object prototype, and duplicate detection uses
own-property checks. Names such as `constructor` and `__proto__` are supported, not banned.
Consumer definitions must supply own named properties: use computed `['__proto__']`
keys or prototype-free objects instead of JavaScript's special prototype-setting literal.

Zero false cutoff relies on consumer canonicalization: erasing meaningful precision or
policy differences is a correctness bug, not a graph optimization. Determinism and complete
recipe identity are consumer obligations. Cache lookup never skips upstream selection or
consumer acceptance: only `Accepted` executions create materializations/cache pins;
`Observe` is never action-cache keyed. If acceptance behavior changes, its policy identity
must change the recipe. The graph does not re-run a consumer verifier on deterministic cache
hits; it reuses the already accepted artifact for that exact recipe and input identity.

## Observations and freshness

`Observe` runs only when its NodeId appears in an explicit refresh request, including the
first build. Without refresh it reads the selected head; missing head or changed
recipe/input action fails closed and requests explicit refresh. Accepted results select a
new head; rejected results keep the old selected head and return a `Rejected` trace outcome.
Failures preserve that head and confirmation. They never create successful cache entries.
Rejections can still allow descendants to reuse the old selected value; failure propagates
rather than pretending the refresh succeeded.

A separate head confirmation record stores `{ key, action, materialization, lastConfirmedAt }`.
An accepted identical observation advances `lastConfirmedAt` from `Clock` while leaving
output and materialization digests unchanged. No clock enters an action or output digest.
The confirmation record necessarily has new CAS bytes when its timestamp changes: the
literal interpretation of “time never enters any hash” would contradict storing that
record in CAS. Time is confined to confirmation metadata, never semantic/cache identity.

`isStale` compares caller-provided now/maxAge with the confirmation, even after a failed
fetch. `planRefresh` is pure: callers provide an observation-head inventory and a policy
mapping opaque keys to non-negative maxAge in milliseconds; it ranks most overdue first,
ties by NodeId, and returns at most the non-negative integer budget. It does not fetch,
retry, mutate heads, or enumerate storage. Consumers enforce finite time/policy/budget
inputs and expiry in their own read/publication gates. Missing observations require explicit
initial refresh; they are not magically discovered by planning existing heads.

## Storage and publication order

All immutable objects use the existing CAS fan-out `sha256/<first-byte>/<rest>` layout.
All manifests use schemaVersion 1 and existing `ContentManifest` / `ContentManifestEntry`.

| Object / mutable pin                 | Role and entries                                                                                                |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| action manifest                      | `data-graph.action`: `recipe`, sorted named `input` entries                                                     |
| accepted materialization             | `data-graph.materialization`: `action`, named `output`, opaque `receipt` descriptors                            |
| rejected / failed attempt            | `data-graph.attempt`: `action`, `status` (Failed/Rejected, reason, UUID invocation identity), `receipt` entries |
| head wrapper                         | `data-graph.head`: `confirmation` blob plus `materialization` descriptor                                        |
| `data-graph/actions/<actionKeyHex>`  | `ContentPin` targeting accepted deterministic materialization                                                   |
| `data-graph/heads/<nodeIdDigestHex>` | `ContentPin` targeting head wrapper manifest                                                                    |

A UUID distinguishes identical unsuccessful invocations without adding time to action or
output identities. Receipts are consumer-owned opaque CAS descriptors, checked for presence
and integrity before publication. The wrapper is necessary because `pinManifest` accepts
only manifest targets, not arbitrary confirmation blobs. Accepted materializations retain
exact recipe/input descriptors through their action entry, and selected outputs/receipts
through their materialization entries.

Write recipe/input/output/receipt blobs, then manifests, then pins. Existing atomic pin writes
prevent partially written pin records. The graph checks immediate manifest children and
output-set/action binding on cache reads and CAS checks bytes. Corruption or missing content
fails closed, never silently recomputes over a corrupt cache. A crash may leave unreachable
objects, or an accepted action pin without its new head; replay can recover the deterministic
head from that action pin. Rejected/failed attempt manifests have **no head/action pin**.
They remain written objects; inventory and durable retention are explicitly unresolved.
This spike handles typed executor failures. Defects, interruptions, process crashes, or
storage failure during attempt recording can leave no completed attempt; it does not claim
an invocation ledger or transactional crash recovery for those cases.

Pins are atomic individually, not a transaction over action and head and not compare-and-set.
One caller must own a store's writes in this spike. Schema-decoding, CAS, graph-contract and
executor errors stay explicit; graph execution never retries.

## Runnable evidence

`src/scenario.ts` is one shared assertion surface used by `src/spike.ts` and
`src/mod.integration.test.ts` (`@effect/vitest`). It uses a scoped real temporary filesystem
CAS and TestClock, counts every executor, checks every node outcome sequence, unchanged
value/evidence digest behavior, three distinct failed/rejected attempt manifests, and
absence of observation action-cache pins. The extra `bundle` node makes the demo a single
pull across both renders and the evidence gate. No mocks, network, or new dependencies.

From this package directory:

```sh
CI=1 ../../../node_modules/.bin/vitest run src/mod.integration.test.ts --config vitest.config.ts
bun src/spike.ts
```

The script prints deterministic outcome sequences and executor counts. The scope deletes
the temporary CAS. These demonstrate the contract; they do not exercise concurrent writers,
restart/crash injection, production canonicalizers, high cardinality, or garbage collection.

## Open choices

- **Pin compare-and-set / concurrent writers:** content-address has no conditional pin
  primitive. Do not patch it in this spike. Choose fencing/CAS before multi-writer use;
  sequential ownership is not an eventual concurrency guarantee.
- **Registry / scale:** pins versus a SQLite index for inventories and thousands of
  fine-grained nodes per scope. Planning currently requires a supplied inventory;
  no ad hoc directory scan is the public registry API.
- **GC roots / retention:** heads, successful action pins, published artifact closures,
  and consumer-required receipts/attempts need distinct retention policies. Unpinned
  attempts are not disposable by implication; decide a durable attempt index/root before GC.
- **Dynamic dependencies:** out of scope. If admitted later, define a discovered-input
  manifest and validation protocol before claiming action identity completeness.
- **Observation acceptance hook ownership:** this API puts `Accepted`/`Rejected` in the
  consumer executor. A graph-level hook could standardize receipts, but must not turn
  action-cache lookup into a bypass of consumer selection/admission.
- **Typed outputs / executor environments:** the spike uses runtime-checked names and
  pre-provided Effect services. Evaluate a typed definition builder with inferred outputs
  and service/error channels without weakening the persisted generic contract.
- **Rejected observations after recipe changes:** preserve old head, expose Rejected on
  that refresh; subsequent non-refresh reads fail the action check. Decide an explicit
  consumer stale-selection policy rather than silently relabeling old acceptance.
- **Freshness-sensitive downstream gates:** how do confirmation (`lastConfirmedAt`)
  changes reach these gates while preserving semantic reuse? Confirmation is outside
  ordinary output dependencies, so scheduling alone cannot expire a cached publication.
  Recommend evaluating freshness-sensitive gates at read/publish time from the selected
  head confirmation plus explicit `now`, consistently with `isStale`, rather than by graph
  rebuild. A dedicated confirmation dependency channel is an alternative if the owner
  explicitly prefers persisted freshness-derived graph outputs.

## Explicitly out of scope

Durable Workflow execution, retries, background scheduling, transport, parallel execution,
concurrent-head arbitration, query/UI inventory, storage migration, automatic GC, semantic
canonicalization, consumer authorization, and external-service determinism. There is no
in-memory adapter in this spike: the required proof intentionally uses actual CAS writes;
`GraphStoreApi` leaves an adapter seam without a pretend production implementation.

Package and TypeScript configuration are genie-authored following the content-address
patterns, and the package is registered in the workspace generators. Lockfile importer
and BUCK projection integration are deliberately deferred to the subsequent integration
step by the coordinator; the runnable proof reuses already installed Effect 4 dependencies.
The offline lockfile-only install was withdrawn by its 300-second queue deadline before
admission. Package-local project checking encounters the sibling noEmit/reference conflict
(TS6310); a scoped source-only TypeScript invocation is the independent spike check.
