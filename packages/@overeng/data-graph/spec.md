# Data graph

An Effect 4 graph execution contract and filesystem adapter over `@overeng/content-address`. Consumers supply topology, recipes, canonical scope JSON, output bytes, and acceptance policy. The graph does not interpret domain data.

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
