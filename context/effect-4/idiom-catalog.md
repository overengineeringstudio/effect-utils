# Effect 4 idioms: decision-ready adoption catalog

Identity: `org.schickling.eu.effect-4.idioms`

All repository work was read-only. Counts are lexical over package TS/TSX and include tests/examples.
`VERIFIED` means inspected in the supplied checkouts or GitHub metadata on 2026-07-28; `INFERRED`
is explicit. Public paths below are repository-relative.

## Owner decision table

Ranked by value, not by raw site count.

| rank | pattern                                                                     | coupling        | verified local surface                                                                                  | recommendation         | owner decision   |
| ---: | --------------------------------------------------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- | ---------------------- | ---------------- |
|    1 | Preserve Schema encoded contracts while adopting v4 codecs/checks           | MUST-CHANGE     | 234 wire-sensitive occurrences / 91 files / 22 packages; broader Schema-shape surface is 723 / 160 / 24 | **ADOPT-DURING**       | approve / reject |
|    2 | `Context.Service` + explicit named layers + direct `yield*`                 | MUST-CHANGE     | 57 service definitions/usages / 42 files / 13 packages                                                  | **ADOPT-DURING**       | approve / reject |
|    3 | Yield Effectable child-process commands; delete executor/start plumbing     | TOUCHING-ANYWAY | 47 command/executor occurrences across 17 files / 7 packages                                            | **ADOPT-DURING**       | approve / reject |
|    4 | Use v4 fork defaults; add options only when a two-major probe requires them | TOUCHING-ANYWAY | 48 fork/forkScoped sites / 28 files / 12 packages                                                       | **ADOPT-DURING**       | approve / reject |
|    5 | Replace unsafe `FiberRef` toggle with `Context.Reference`                   | MUST-CHANGE     | 3 operations in one `utils` file                                                                        | **ADOPT-DURING**       | approve / reject |
|    6 | `Effect.async` -> `Effect.callback`, preserving cancellation registration   | MUST-CHANGE     | 15 sites / 8 files / 4 packages                                                                         | **ADOPT-DURING**       | approve / reject |
|    7 | Native v4 Schema class/array/check/annotation forms                         | MUST-CHANGE     | includes 187 `Schema.TaggedError` sites / 63 files / 21 packages                                        | **ADOPT-DURING**       | approve / reject |
|    8 | Canonical v4 catch names, without reason-model redesign                     | MUST-CHANGE     | 112 `catchAll` + 7 `catchAllCause`, 52 files / 14 packages                                              | **ADOPT-DURING**       | approve / reject |
|    9 | Module-owned concurrency constructors (`Semaphore.make`)                    | MUST-CHANGE     | 2 sites / 2 packages                                                                                    | **ADOPT-DURING**       | approve / reject |
|   10 | Broad layer-graph composition cleanup                                       | INDEPENDENT     | 795 `Effect.provide` occurrences / 202 files; heat concentrated in megarepo, Restate, Notion, TUI       | **ADOPT-AFTER**        | approve / reject |
|   11 | Convert functions returning `Effect.gen` to named `Effect.fn`               | INDEPENDENT     | 35 clear sites / 23 files / 9 packages; 519 `Effect.fn` sites already exist                             | **ADOPT-AFTER**        | approve / reject |
|   12 | Replace existing errors with reason-bearing errors                          | INDEPENDENT     | no bounded mechanical surface; error-heavy packages span most of repo                                   | **SKIP** for migration | approve / reject |
|   13 | Add an Effect facade analogous to `@livestore/utils/effect`                 | INDEPENDENT     | no equivalent facade; Effect imports span 31 packages                                                   | **SKIP**               | approve / reject |
|   14 | Broadly rewrite combinator pipelines into `Effect.gen`                      | INDEPENDENT     | `Effect.gen` already occurs in 314 files                                                                | **SKIP**               | approve / reject |

## Cheapest high-value set: approve these five

1. **Schema contract-first rewrite.** It addresses the largest silent-breakage class and turns the
   existing differential harness into a byte-level acceptance oracle.
2. **Explicit v4 services/layers.** The API must change anyway; doing the full v4 form deletes
   generated accessors/dependency wiring instead of recreating them locally.
3. **Effectable commands.** This is the best deletion opportunity: v4 makes commands effects, so
   most explicit executor/start plumbing is obsolete.
4. **Default fork semantics backed by probes.** This avoids LiveStore's demonstrated compatibility
   cargo cult and makes non-default scheduling policy locally justified.
5. **`Context.Reference` for `ScopeDebugEnabled`.** One contained migration deletes
   `FiberRef.unsafeMake` while preserving the intended inherited, fiber-local toggle.

These five are reviewable as recipes with differential proofs. They do not include broad cleanup
whose success criterion would be “looks nicer.”

## What LiveStore actually did

### Source correction

**VERIFIED:** the brief's `#1339`, `#1340`, `#1341`, `#1316`, `#1315`, `#1318`, `#1320`, and
`#1321` are closed migration **issues**, not PRs (`gh pr view` cannot resolve them; `gh issue view`
does). The actual package PRs, listed by landing PR #1383, are:

| issue | actual PR | slice                    |
| ----: | --------: | ------------------------ |
| #1319 |     #1342 | webmesh                  |
| #1314 |     #1343 | common                   |
| #1339 |     #1349 | common-cf                |
| #1317 |     #1350 | sync-cf                  |
| #1340 |     #1344 | effect-playwright        |
| #1341 |     #1345 | sqlite-wasm              |
| #1316 |     #1352 | adapter-web              |
| #1315 |     #1353 | livestore core           |
| #1318 |     #1354 | react                    |
| #1320 |     #1355 | docs/examples/tests/perf |
| #1321 |     #1359 | finalization             |

PRs #1322, #1323, and #1332 are correctly numbered in the brief. The complete landing PR is #1383.

### Adopted versus deferred

| LiveStore choice                                                                                                              | evidence                                                                                            | implication here                                                                                         |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Adopted direct import topology and mechanical API names first                                                                 | PR #1323; commits `c96100d11`, `11fe7d887`                                                          | Keep mechanical rewrites separate from judgment-heavy recipes.                                           |
| Adopted `Context.Service`, callback constructors, RPC-native workers, and explicit layers where v4 required structural change | PR #1332; `utils/src/browser/Opfs/Opfs.ts:222-226`; `utils/src/browser/WebLock.ts:49-73`            | These are admissible during migration when the v3 behavior trace is locked first.                        |
| Adopted v4 layer composition in worker boot paths                                                                             | PR #1352                                                                                            | Restrict to touched/required graphs; do not use this as license for repo-wide graph redesign.            |
| Changed an async-iterator implementation when the old bridge raced under v4                                                   | PR #1353                                                                                            | This is a behavior repair, not an idiom precedent; it required focused tests.                            |
| Deferred fork-option audit                                                                                                    | #1356 / PR #1369, commit `87fecd4a`                                                                 | The copied compatibility options were unnecessary; probe before adding any.                              |
| Deferred and then deleted v3 MessageChannel scheduler                                                                         | #1357 / PR #1370, commit `55bf025f`                                                                 | Delete a local runtime shim only when v4 owns the same policy and callers do not require a distinct one. |
| Deferred Vitest config work                                                                                                   | #1358 / PR #1368                                                                                    | Tool config is separable follow-up work, not an Effect source idiom.                                     |
| Deferred Schema-native table redesign                                                                                         | recovered `contributor-docs/effect-4.md`; open PR #1308 still exists                                | Redesign is not behavior-preserving migration work.                                                      |
| Did not broadly adopt `Effect.fn`                                                                                             | local lexical comparison: dev 116 -> main 84 `Effect.fn`; functions returning `Effect.gen` 20 -> 18 | Upstream preference was not treated as migration scope.                                                  |
| Retained and adapted the facade rather than newly choosing it                                                                 | facade imports dev 372 -> main 299; current facade `utils/src/effect/mod.ts:3-129`                  | A pre-existing boundary is not evidence that effect-utils should introduce one.                          |

The first three deferred items were handled immediately after the landing stack. That supports a
short, named post-migration idiom phase; it does not support mixing redesign into the green-up
critical path.

## Catalog

### 1. Contract-first Schema v4 codecs and checks

**v3 form:** persisted JSON is commonly encoded through
`Schema.encode(Schema.parseJson(stateSchema))`, e.g.
`packages/@overeng/tui-react/src/effect/TuiApp.tsx:716-795`; Date transforms use
`Schema.DateFromSelf`, e.g. `packages/@overeng/notion-effect-schema/src/properties/audit.ts:49-53`.
**v4 form:** use `Schema.fromJsonString(schema)` (or `Schema.UnknownFromJsonString`) and choose Date
semantics explicitly: v3 `Schema.Date` wire behavior becomes
plain `Schema.DateFromString` **at beta.102** (`Schema.isDateValid` was removed after beta.99 and `Schema.Date` now rejects invalid dates natively); v3 self-Date becomes v4 `Schema.Date`.
Use `Schema.toCodecJson` at transport boundaries that require JSON-safe representations.
**Why better:** v4 separates value schemas, string codecs, JSON codecs, and checks. The benefit is
not naming: the encoded boundary becomes explicit and cannot accidentally inherit the wrong Date
meaning. Upstream warns that `Schema.Date` can still typecheck while accepting different input
(`migration/schema.md:91-113`). LiveStore experienced exactly that after landing: PR #1436 /
`ddd1aa16c`.

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED 234 occurrences of `parseJson`, Date/DateFromSelf, or `optionalWith`
across 91 files / 22 packages. High-risk boundaries are enumerated in worker 3: Notion canonical
JSON/frontmatter/SQLite, agent JSONL/checkpoints, TUI JSON/NDJSON, megarepo durable JSON, Restate
serde, and CI reports.
**Differential proof:** for every durable/wire schema, feed identical encoded fixtures to v3/v4;
assert decoded normalized value, re-encoded exact UTF-8 bytes/key omission/default behavior, and
the same invalid-input success/failure partition. Include valid/invalid dates, absent/undefined/null,
pretty-print spacing, and JSON-only transforms. A semantic-only equality assertion is insufficient.
**Recommendation:** **ADOPT-DURING** — this is the highest-value behavior-preserving recipe and must
be completed boundary by boundary, never by compile-only replacement.

### 2. `Context.Service`, explicit layers, and direct service yields

**v3 form:** `Otelite` and `OteliteTestHarness` use `Effect.Service`, `accessors: true`,
auto-generated `.Default`, and inline `dependencies`
(`packages/@overeng/utils-dev/src/otelite/Otelite.ts:149-152`;
`test-harness.ts:200-205,356-369`). Other services use
`class X extends Context.Tag(id)<X, Shape>()`, e.g.
`packages/@overeng/notion-md/src/state-store.ts:243`.
**v4 form:**

```ts
class Otelite extends Context.Service<Otelite, Service>()('...') {
  static readonly layer = Layer.effect(this, make).pipe(Layer.provide(NodeContext.layer))
}
const otelite = yield * Otelite
yield * otelite.capture(options)
```

**Why better:** v4 deletes accessor proxies that erase generic/overloaded method types and deletes
implicit dependency wiring. The resulting service requirement and layer graph are explicit and
locally typechecked (`effect/migration/services.md:63-140,142-199`). LiveStore used this structural
form in PR #1332; its OPFS service is explicit at `utils/src/browser/Opfs/Opfs.ts:222-226`.

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED 57 service-form occurrences / 42 files / 13 packages. Restate is largest
(11 files); then `utils-dev`, `utils`, and megarepo (4 each).
**Differential proof:** for each service recipe, record constructor count/order, acquired resources,
method results/errors, finalizer order, and dependency requests. Run with production and test
layers. The v4 trace must match v3, including whether dependencies are built once or per scope.
**Recommendation:** **ADOPT-DURING** — do the native v4 structure rather than recreating `.Default`
or accessor proxies; use lowercase `layer` / descriptive variants consistently.

### 3. Effectable child-process commands

**v3 form:** yield `CommandExecutor`, then call `executor.start(command)`, e.g.
`packages/@overeng/effect-ai-claude-cli/src/claude-cli.ts:213-246`; similar plumbing exists in
`utils-dev/src/otelite/Otelite.ts:149-176`. `utils/src/node/cmd.ts:452-468` builds a command only to
call `Command.exitCode`.
**v4 form:**

```ts
const handle =
  yield *
  ChildProcess.make('claude', args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
const exitCode = yield * handle.exitCode
```

Use `ChildProcessSpawner` only for its higher-level collection helpers or a custom spawn
implementation; a `ChildProcess.Command` is itself an Effect.
**Why better:** deletes an otherwise redundant service lookup and start adapter; the command value
now directly describes construction plus spawning. Upstream explicitly makes commands Effectable
(`migration/v3-to-v4.md:6344-6386`). LiveStore PR #1332 deleted its old serialized
`ChildProcessRunner` abstraction when v4 RPC/worker primitives superseded it.

**Coupled to the migration?** TOUCHING-ANYWAY (`CommandExecutor` is renamed and command options are
reshaped).
**Blast radius:** VERIFIED 47 command/executor occurrences across 17 files / 7 packages; megarepo
and genie dominate. Do not delete `utils/cmd` wholesale: its log mirroring, process-group kill, and
flush behavior at `cmd.ts:475-598` is repo policy not supplied by v4.
**Differential proof:** exact argv/env/cwd/shell/stdin bytes, stdout/stderr ordering, exit code,
spawn failure classification, interruption signal/escalation, process-group teardown, and scoped
finalizer completion. For `utils/cmd`, include partial final lines and concurrent stdout/stderr.
**Recommendation:** **ADOPT-DURING** — delete only executor/start boilerplate made obsolete by
Effectable commands; retain proven policy wrappers.

### 4. Default fork semantics; no speculative compatibility options

**v3 form:** `Effect.fork(effect)` and unchanged `forkScoped` sites, e.g.
`packages/@overeng/notion-md/src/webhook.unit.test.ts:115` and
`packages/@overeng/utils/src/node/cmd.ts:557-567`.
**v4 form:** `Effect.forkChild(effect)`, `Effect.forkDetach(effect)`, `Effect.forkScoped(effect)`;
omit `{ startImmediately, uninterruptible }` unless a local two-major probe proves a difference
that must be preserved.
**Why better:** each name states lifecycle ownership, and default options avoid undocumented
scheduler/interruptibility policy. LiveStore initially copied
`{ startImmediately: true, uninterruptible: "inherit" }`, then direct probes showed defaults
matched v3 and PR #1369 removed the options from 50+ runtime/test call sites.

**Coupled to the migration?** TOUCHING-ANYWAY for renamed `fork`/`forkDaemon`.
**Blast radius:** VERIFIED 48 `fork`/`forkScoped` sites / 28 files / 12 packages, concentrated in
TUI, Notion, utils, and Restate. No existing explicit compatibility options were found.
**Differential proof:** trace pre-fork, child first instruction, parent continuation, readiness
barrier, interruption, finalizer, and join/await order in fresh processes. For command/TUI/sync
paths, test shutdown at each in-flight transition and max concurrency. LiveStore PRs #1386 and
#1405 demonstrate why “tests pass once” is inadequate.
**Recommendation:** **ADOPT-DURING** — approve a rule forbidding speculative options; any exception
must cite its differential trace.

### 5. `Context.Reference` for the scope-debug toggle

**v3 form:** `FiberRef.unsafeMake(false)`, `FiberRef.get`, and `Effect.locally` in
`packages/@overeng/utils/src/isomorphic/ScopeDebugger.ts:10,27-45,62-68,171-176`.
**v4 form:**

```ts
const ScopeDebugEnabled = Context.Reference<boolean>('.../ScopeDebugEnabled', {
  defaultValue: () => false,
})
const enabled = yield * ScopeDebugEnabled
const run = Effect.provideService(effect, ScopeDebugEnabled, true)
```

**Why better:** removes unsafe construction and models fiber-local configuration through the v4
context/reference mechanism. This is precisely the v4 replacement for FiberRef-based application
state (`migration/fiberref.md:1-10,50-82`).

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED one file, three FiberRef operations, one exported reference.
**Differential proof:** parent default false; nested override true; child inherits true; sibling and
post-scope value remain false; finalizer logs occur exactly when enabled; concurrent fibers do not
leak values.
**Recommendation:** **ADOPT-DURING** — contained, high-confidence deletion of an unsafe v3 primitive.

### 6. `Effect.callback` with preserved cancellation

**v3 form:** `Effect.async((resume, signal) => ...)`, for example Web Locks at
`packages/@overeng/utils/src/browser/web-lock.ts:96-159`.
**v4 form:** identical registration logic under `Effect.callback`; if registration owns a listener
or handle, return its Effect cleanup action rather than hiding cleanup elsewhere.
**Why better:** the name states the source is callback-driven, and v4 permits effectful cleanup
from registration. Upstream says resume/AbortSignal semantics are otherwise the same
(`migration/v3-to-v4.md:9506-9508,11615-11625`). LiveStore made the exact WebLock rename in PR
#1332 (`dev WebLock.ts:50-74` -> `main WebLock.ts:49-73`) without restructuring it.

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED 15 sites / 8 files / 4 packages (`restate-effect`, `utils`,
`notion-datasource-sync`, `notion-md`).
**Differential proof:** registration timing, single resume, AbortSignal state, external listener
removal, late callback after interruption, error/defect channel, and no leaked lock/listener.
**Recommendation:** **ADOPT-DURING** — mechanical rename by default; adopt returned cleanup only
where the v3 recipe proves equivalent ownership.

### 7. Native v4 Schema forms, including `TaggedErrorClass`

**v3 form:** `Schema.TaggedError`, variadic `Schema.Literal`/`Schema.Union`,
`Schema.filter`, and `Schema.annotations`; representative error:
`packages/@overeng/effect-path/src/errors.ts:15-34`.
**v4 form:** `Schema.TaggedErrorClass`; `Schema.Literals([...])`; `Schema.Union([...])`;
`Schema.check(Schema.makeFilter(...))` or `Schema.refine`; `.annotate(...)`.
**Why better:** mostly not “better”—these are v4's canonical typed constructors. The actual benefit
is refusing compatibility helpers that hide v4 shapes. `react-inspector` deliberately uses native
array `Schema.Union(members)` and `Schema.check(...)`
(`src/schema/lineage.ts:62-83`; `effect4.unit.test.tsx:52-68`), although its local variadic `union`
helper should not become a repo convention.

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED 187 `Schema.TaggedError` occurrences / 63 files / 21 packages. The wider
constructor/check/annotation lexical surface is 723 occurrences / 160 files / 24 packages.
**Differential proof:** constructor `_tag`, own/enumerable keys, `instanceof`, yield behavior,
encoded/decoded bytes, annotations/formatter output, and identical pass/fail sets for every check.
**Recommendation:** **ADOPT-DURING** — native v4 forms only; reject a compatibility facade/helper
unless it preserves a deliberate public API.

### 8. Canonical catch names without changing the error model

**v3 form:** `Effect.catchAll` / `catchAllCause`, e.g.
`packages/@overeng/utils/src/node/file-system-backing.ts:77` and
`packages/@overeng/utils/src/isomorphic/ScopeDebugger.ts:102`.
**v4 form:** `Effect.catch` / `catchCause`. Keep `catchTag(s)` where already used. Only use
`catchFilter` when migrating an actual v3 `catchSome`; do not introduce reason errors here.
**Why better:** purely canonical naming; no independent design value. Upstream's rename table is
`migration/error-handling.md:1-19`.

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED 112 `catchAll` plus 7 `catchAllCause` sites, 52 files / 14 packages.
There are no current `catchSome*` sites.
**Differential proof:** same success/failure/defect/interrupt exits and same handler invocation
count for representative tagged, untagged, cause, and interruption cases.
**Recommendation:** **ADOPT-DURING** — approve as mechanical migration, not as an idiom project.

### 9. Module-owned semaphore constructor

**v3 form:** `yield* Effect.makeSemaphore(1)` in
`packages/@overeng/effect-distributed-lock/src/DistributedSemaphore.ts:182` and
`packages/@overeng/megarepo/src/lib/store-lock.ts:81`.
**v4 form:** `yield* Semaphore.make(1)`.
**Why better:** namespace ownership makes the primitive discoverable and avoids an overloaded
Effect namespace; behavior benefit is purely organizational.

**Coupled to the migration?** MUST-CHANGE.
**Blast radius:** VERIFIED two sites / two packages.
**Differential proof:** permit count, FIFO/contention order, interruption while waiting, release
after success/failure/interruption, and no concurrent critical-section overlap.
**Recommendation:** **ADOPT-DURING** — cheap required rewrite with an existing strong lock suite.

### 10. Broad layer composition

**v3 form:** nested separate provides, e.g. megarepo status provides `outputModeLayer` then
`StoreLayer` (`packages/@overeng/megarepo/src/cli/commands/status.ts:510-533`).
**v4 form:** build a named composed layer and provide once; where v3 intentionally rebuilt a layer,
use `Layer.fresh` or `Effect.provide(layer, { local: true })`.
**Why better:** a named graph exposes ownership/dependencies and prevents accidental duplicate
construction. But v4 already changes memoization across separate provides, so a cosmetic rewrite
can conceal a behavior change (`migration/layer-memoization.md:3-11,44-98`).

**Coupled to the migration?** INDEPENDENT, except explicit `Effect.Service.dependencies` rewrites.
**Blast radius:** VERIFIED 795 `Effect.provide` occurrences in 202 files. Worker 3's heat table puts
the largest review burden in megarepo, Restate, Notion, utils, and TUI.
**Differential proof:** constructor/finalizer counts and order, resource identity, test isolation,
failure acquisition/release, and overlapping layer reuse. Without those counters it cannot be
proven behavior-preserving.
**Recommendation:** **ADOPT-AFTER** — during migration, compose only layers already structurally
touched and add `local`/`fresh` where required to preserve v3 counts.

### 11. Named `Effect.fn`

**v3 form:** functions returning `Effect.gen`, e.g.
`packages/@overeng/notion-md/src/reconcile.ts:197-225`.
**v4 form:** `const assertReviewMarkupAllowed = Effect.fn("...")(function* (opts) { ... }, ...)`.
**Why better:** upstream says names improve stack traces and automatically attach tracing spans
(`LLMS.md:50-82`). This repo already uses `Effect.fn` extensively.

**Coupled to the migration?** INDEPENDENT.
**Blast radius:** VERIFIED 35 clear return/arrow `Effect.gen` sites / 23 files / 9 packages, versus
519 existing `Effect.fn` occurrences.
**Differential proof:** values/exits may match, but named `Effect.fn` intentionally changes
spans/stack traces. If normalized traces include telemetry, “changes nothing” is impossible.
**Recommendation:** **ADOPT-AFTER** as an explicitly observable telemetry/diagnostics change, not
under the no-behavior-change migration claim. LiveStore did not mass-adopt it.

### 12. Reason-bearing errors

**v3 form:** flat tagged errors such as `InvalidPathError.reason: InvalidPathReason`
(`packages/@overeng/effect-path/src/errors.ts:15-34`).
**v4 form:** a parent tagged error with tagged reason classes, handled via
`Effect.catchReason(s)` / `unwrapReason`.
**Why better:** valuable when callers share a stable parent error but need typed recovery for
specific reasons. It changes public types, constructors, schema bytes, matching, and error
transport.

**Coupled to the migration?** INDEPENDENT.
**Blast radius:** INFERRED broad and unbounded; must be selected domain by domain.
**Differential proof:** cannot truthfully prove “no behavior change” for public/wire errors because
the encoded/type shape intentionally changes.
**Recommendation:** **SKIP** in this epic; propose separate API-design work only where a consumer
problem justifies it.

### 13. Repository-wide Effect facade

**v3 form:** each package imports `effect` / `@effect/*` directly; no effect-utils equivalent of a
central re-export facade was found.
**v4 form:** route imports through a new facade analogous to LiveStore's
`packages/@livestore/utils/src/effect/mod.ts:3-129`.
**Why better:** centralizes import topology for an application monorepo, but creates a dependency
funnel and obscures stable/testing/unstable/browser boundaries in a multi-package utility repo.
LiveStore's facade also caused a real browser failure when it re-exported `effect/testing` and
pulled `node:assert` (PR #1433 / `8c453ef94`).

**Coupled to the migration?** INDEPENDENT.
**Blast radius:** all Effect-using packages and downstream import policy.
**Differential proof:** runtime values can be checked, but package graph, tree-shaking, browser
bundling, duplicate identity, and public type declarations are observable. A facade is not
behavior-neutral.
**Recommendation:** **SKIP** — use v4 package boundaries directly. LiveStore's facade is an adapted
pre-existing architecture, not a migration idiom to copy.

### 14. Broad combinator-to-generator rewrite

**v3 form:** existing `pipe`/`flatMap`/`map` chains.
**v4 form:** `Effect.gen` with `yield*`.
**Why better:** can improve sequential readability, but is stylistic when the chain is already
clear; may alter laziness/evaluation placement if rewritten carelessly.

**Coupled to the migration?** INDEPENDENT.
**Blast radius:** enormous; `Effect.gen` already occurs in 314 files, so the repository has no
missing-generator problem.
**Differential proof:** possible per function, but review and harness cost dwarfs value.
**Recommendation:** **SKIP** as a migration initiative; allow local use only when a mandatory v4
rewrite makes the old structure materially harder to read.

## Dangerous during-migration attractions

| attractive change                                   | why dangerous                                                         | rule                                     |
| --------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| Named `Effect.fn` everywhere                        | intentionally adds spans / changes stacks                             | separate post-migration telemetry change |
| Compose every layer graph                           | v4 memoization can change acquisition count even if types pass        | instrument constructors/finalizers first |
| Add fork compatibility options                      | LiveStore proved its copied options unnecessary; scheduling is subtle | defaults unless a two-major trace fails  |
| “Improve” Schema models while changing constructors | wire/default/null/optional behavior can typecheck and drift           | preserve encoded fixtures byte-for-byte  |
| Introduce reason errors                             | changes public and encoded error shape                                | separate API design                      |
| Add a facade                                        | changes dependency/bundle/public-type boundaries                      | reject for effect-utils                  |
| Copy `react-inspector`'s variadic `union` helper    | hides v4 native array form and perpetuates v3 calling style           | use native arrays directly               |

## What `react-inspector` should teach the rest of the repo

**Copy selectively (VERIFIED):**

- native v4 array `Schema.Union(members)` (`src/schema/lineage.ts:62-83`);
- composable v4 `Schema.check` predicates and explicit formatter override
  (`src/schema/effect4.unit.test.tsx:52-68`;
  `test-d/exact-optional-consumer.ts:18-20`);
- `Schema.Top` at a public schema boundary and exact-optional consumer compilation
  (`src/object-inspector/ObjectInspector.tsx:112-123`; `test-d/exact-optional-consumer.ts:6-20`).

**Do not generalize:** it is a deliberately isolated v4 package and mostly pure Schema/UI code. It
does not validate v4 services, layers, scopes, forks, process, CLI, RPC, or durable codecs for the
connected remainder. Its local variadic `union` helper is migration ergonomics, not a house idiom.

## Phasing consequence

**INFERRED but strong:** approving the ADOPT-DURING rows does not require abandoning the epic's
single-green-up structure. Each approved pattern must become a named recipe with:

1. a real v3 fixture/call site;
2. the proposed v4 refactored form;
3. a normalized differential trace schema;
4. a red-on-divergence adversarial case;
5. package ownership and exact allowed surface.

Run mechanical renames first, then approved recipes within package slices. Keep `Effect.fn`, broad
layer cleanup, reason errors, and all redesign in an explicit post-migration phase. This matches the
useful part of LiveStore's adopted/deferred split while improving on its late discovery of wire,
shutdown, and bundling regressions.

## Uncertainty / not covered

- VERIFIED PR bodies and current/pre-migration checkouts establish what LiveStore changed, but no
  formal retrospective exists; motives beyond explicit PR prose/follow-up issues remain inference.
- Lexical counts are prioritization evidence, not AST-precise semantic counts.
- No differential harness was executed and `tmp/effect4-proto/` was not touched, per instruction.
- Whether any nested `Effect.provide` currently relies on duplicate construction is unanswerable
  without the proposed constructor/finalizer probes.
- No private information was used or included.

## PRIVATE

None.
