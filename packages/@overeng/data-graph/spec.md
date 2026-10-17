# Data graph

An Effect 4 graph execution contract and filesystem adapter over `@overeng/content-address`. Consumers supply topology, recipes, canonical scope JSON, output bytes, and acceptance policy. The graph does not interpret domain data.

## Package distribution

`@overeng/data-graph` is admitted to the Buck/Nix package-product inventory alongside `@overeng/content-address` and `@overeng/effect-rust`. Package archives resolve workspace dependency ranges to sibling package versions, so artifact-only consumers do not need workspace source edges. The normal publisher on `main` produces the cached artifact and `nix/buck2-products/manifest.json`; inventory admission alone does not publish an artifact.

## Identity and execution

A `NodeDef` is a `Derive` or `Observe` template with a non-empty branded `kind`, named outputs, scope-dependent static named inputs, a recipe, and an Effect executor. A `NodeRef` binds an instance scope and one output. Node identity is canonical JSON of `{ kind, scope }`; selecting an output does not change identity. Dependencies are declared before execution, never discovered by the executor. Cycles, conflicting definitions, and invalid output sets fail explicitly.

An action manifest binds the canonical recipe descriptor and sorted named input descriptors. `actionKey({ recipe, inputs })` exposes this identity without storage access. Recipes include version and configuration; all acceptance-policy and model/configuration changes that affect behavior must change the recipe. Input descriptor identity includes metadata, not just bytes. Consumers are responsible for complete recipe identity and determinism.

`materialize(ref, { refresh? })` resolves each instance once per pull, selects every upstream before consulting deterministic cache, and returns selected output descriptors and a postorder trace (`Executed`, `Reused`, `Rejected`). `Derive` reuses only previously accepted actions. Named output digest equality cuts off downstream work even when an upstream recipe changes. Arbitrary valid names including `__proto__` and `constructor` are data, not object-prototype operations.

`Observe` requires explicit refresh for its initial selection and whenever recipe or selected-input action changes. Otherwise it reuses its current selected head. Nondeterministic model results are `Observe` nodes with explicit refresh, not cached deterministic computations. An accepted identical observation changes confirmation time only: semantic output and materialization descriptors remain equal. Failed refresh never advances confirmation. Rejection preserves the historical selected head and exposes a rejected outcome; serving stale-but-accepted content is a consumer decision.

## Storage and ownership

`GraphStore.fileSystem(root)` reuses content-address byte, manifest, and pin primitives. CAS manifests and pins are authoritative; there is no SQLite registry or alternative serializer. Registry inventories are consumer-supplied, not inferred through directory scans.

| Object / pin                                  | Meaning                                                      |
| --------------------------------------------- | ------------------------------------------------------------ |
| `data-graph.action`                           | Recipe and sorted input descriptors                          |
| `data-graph.materialization`                  | Action, named outputs, opaque receipts                       |
| `data-graph.attempt`                          | Unsuccessful action, UUID invocation status/reason, receipts |
| `data-graph.head`                             | Confirmation record and selected materialization             |
| `data-graph/actions/<action digest hex>`      | Accepted deterministic cache entry                           |
| `data-graph/heads/<node identity digest hex>` | Selected head                                                |

Writes publish bytes, then manifests, then atomic individual pins. CAS verifies object integrity. Missing/corrupt objects fail closed rather than silently executing over a broken cache. An unpublished manifest is not a selection. An accepted deterministic action pin without its head can recover the head on the next pull. Individual pins are not a multi-object transaction. Defects, interruption, process crash, and storage failure may leave no completed attempt.

Single-writer ownership is required. Pulls sharing a filesystem root serialize through one process-local Effect semaphore, including separately constructed layers. Root aliases through symlinks must not be used as separate owners. Cross-process/multi-writer use is unsupported and requires a future bakeoff between fenced ownership and conditional head updates: an older owner must never overwrite a newer selection. No content-address primitive is changed to pretend otherwise.

No automatic GC until durable attempt roots and publication/evidence closures exist. Unreachable or superseded objects must not be treated as disposable by implication.

## Evidence and publication

`value` and `evidence` are ordinary separately named outputs. Publication-relevant metadata, such as rights/licence, must be a named evidence OUTPUT consumed by a gate node, not only an opaque receipt. The generic scenario binds the evidence channel into a `policy-gate`; receipts remain provenance, not dependency identity. Consumers must not assume unchanged value bytes imply unchanged admissibility.

Confirmation time is outside semantic action/output identities. Freshness gates run at read/publish time against selected-head confirmation and explicit `now`; graph execution is not necessary to detect expiry. `isStale({ head, now, maxAge })` treats absent confirmation as stale and expires at the age boundary. Consumers own valid finite times and non-negative budgets/ages, as well as publication decisions.

## Evidence and commands

Tests use `@effect/vitest`, real scoped temporary filesystem CAS, explicit FS timeouts, and controlled clocks. Identity properties cover input permutation/determinism and recipe/input descriptor changes; filesystem properties cover arbitrary output/input names and output digest cutoff. The scenario checks semantic and evidence cutoffs, executor counts, freshness, failed/rejected observations, and absence of observation action-cache pins. Concurrent pulls assert exactly one deterministic execution and one selected materialization.

From this package directory:

```sh
CI=1 ../../../node_modules/.bin/vitest run --config vitest.config.ts
```

`src/spike.ts` remains a small executable example of the shared scenario, not a second implementation.

## Non-goals

Durable Workflow execution, retries, background scheduling, dynamic dependencies, transport, parallel node execution, multi-writer arbitration, query/UI inventory, automatic GC, semantic canonicalization, consumer authorization, and external-service determinism. Consumer services are closed over or provided before node registration. Typed output builders and alternative storage adapters must not weaken the persisted contract.

## Selection status and freshness tiers

`getSelectionStatus(ref)` is a read-only, serialized snapshot of selected-head acceptance and the latest durable attempt. It computes the current recipe/input action from selected upstream heads without executing nodes, propagates stale upstream acceptance, and returns `Missing`, `Current`, or `StaleAction`. A selected historical head is not current acceptance after an action change. `latestAttempt` survives layer/process restart through a `data-graph/attempts/<node identity digest hex>` pin targeting a status manifest. Failed/rejected attempts retain their action, reason and attempt manifest; successful selections replace the status with `Accepted`. Status and head pins are individually atomic, not transactional.

Both materialization and selection-status traversal reject distinct node definition objects with the same kind before reusing a memoized node result. Repeated references to the same definition are valid; a conflicting graph cannot report current acceptance or authorize freshness.

Status reads decode the latest action and attempt manifests and verify their recipe, input, status, and receipt objects, even when the attempted action differs from both the historical selected action and the current recipe/input action. Missing or corrupt attempt evidence fails closed rather than returning a successful persisted rejection.

`checkFreshness({ status, now, maxAge })` is a read/publication gate: only current acceptance with an unexpired selected-head confirmation passes. Expiry is evaluated without graph execution. Serving historical content after rejection is an explicit consumer choice, not implicit renewed acceptance.

`planRefresh({ now, heads, policy, compareTiers, budget })` uses a consumer-supplied observation inventory. Policy returns `{ tier, maxAge }`; tier is opaque, and `compareTiers` supplies its priority (negative means the left tier is scheduled first). Stale requests rank by tier priority, then overdue age, then NodeId, within the integer budget. Planning neither reads storage nor executes nodes.

## Crash recovery and scale evidence

`src/recovery.integration.test.ts` interrupts publication at the action/head pin boundaries while retaining real immutable filesystem writes. It checks that unpinned objects are not selected, deterministic action-only publication recovers without executing again, and a corrupted published materialization fails closed without selecting a head.

`src/scale.integration.test.ts` exercises 1,000 generic opaque observation scopes plus one deterministic aggregate in the default CI suite. It records cold build, warm all-`Reused` pull, persisted-head inventory reading, and tier-prioritized `planRefresh` timings. There is no SQLite index. The 10,000-scope case is runnable but opt-in:

```sh
DATA_GRAPH_SCALE_10K=1 CI=1 ../../../node_modules/.bin/vitest run src/scale.integration.test.ts --config vitest.config.ts -t 'benchmarks 10k'
```

Timings are printed by the actual run; they are workload/environment observations, not portable performance guarantees.

### Warm pull integrity and bounded work

Node resolution is memoized by NodeId within each pull, including multiple references to a shared upstream. Internal immutable CAS reads are verified once per complete descriptor per pull and retained only for that pull; executor-facing `GraphStore.get` remains uncached. A fresh pull re-verifies objects, so corruption cannot hide behind a previous cache hit. Descriptor metadata participates in the memoization key, not only the digest.

Recipe/action descriptors are computed without publishing objects during selection/cache lookup. Their bytes/manifests are persisted only when execution is needed. Reusing the already selected deterministic materialization does not rewrite its recipe/action objects, head, or status pins. This both removes redundant warm I/O and prevents action construction from repairing a corrupt selected action before it is checked. Cache hits still verify manifest closure, declared output set, action binding, and content integrity.

The scale test profiles warm CAS reads, unique read digests, immutable object writes, pins, and pin lookups. `src/cache.integration.test.ts` checks once-per-pull verification, shared-input resolution, zero warm publications, and fail-closed output/action corruption on subsequent pulls. Warm profiling is linear in nodes and declared edges; an index remains outside this contract.
