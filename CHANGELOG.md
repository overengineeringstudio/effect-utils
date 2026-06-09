# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed

- **CI / Nix packages**: Refresh the stale `workflow-report` pnpm fixed-output hash so the Storybook preview reporting step can build `#workflow-report` again after the branch rebase updated the workspace dependency closure.

- **@overeng/restate-effect**: Made `Restate.run`'s type HONEST. A durable `ctx.run` step carries NO catchable typed failure: the inner effect runs via `Runtime.runPromise` inside `ctx.run`, so a typed `Effect.fail` only REJECTS the step (Restate retries; a give-up maps to a `RestateError` DEFECT) and never reaches the outer failure channel — the old `run<A, E, R>(…): Effect<A, E, …>` advertised a typed `E` that `catchTag`/`catchAll` would typecheck against but that could never fire. `run` is now `run<A, R>(name, effect: Effect<A, never, R>, options?): Effect<A, never, …>`, and `runExit` is `runExit<A, R>(…): Effect<Exit<A>, never, …>` — the honest OBSERVATION form, whose failure channel is `never` (an observed failure is a defect/interrupt `Cause`, not a phantom typed `E`). Domain errors now belong in the HANDLER body (classify the step's result there) or are encoded as VALUES inside the step; to force a durable retry, DIE inside the step. A passed typed-`E` inner effect is now a COMPILE error (negative-type assertion in `capability-inference.types.ts`). Callers reconciled: the saga integration test's failing `pay` step `Effect.die`s (was `Effect.fail`), and `examples/12-self-reschedule.ts`'s `pollComposedSource` returns a tagged VALUE with `E = never` (classified in the cycle body, unchanged). `examples/14-http-error-classification.ts` already used the die-the-step / classify-in-body strategies; only its prose was corrected. VRS: decision 0003 (#4 — corrects the earlier "keep the inner `E` flowing through `run`"), 03-effect-runtime / 04-error-boundary specs, the guide handbook, and a DEFERRED typed-failure-transport `run` note (an encoded `fail(E)` journaled via an error schema). No dependency changes.
- **@overeng/restate-effect**: Centralized the contract-invocation policy into ONE boundary (`clients/InvocationPolicy.ts`, decision 0020), fixing two P2 client bugs by construction + the architectural root cause behind them. The annotation-derived transport facts — input/output serde (incl. the `Restate.sensitive`-field redaction transform), the `Restate.idempotencyKey`-field extraction, and the SDK opts bag — were previously assembled SEPARATELY in every adapter (endpoint materialization, each ingress client, the in-handler service-to-service clients, AND the testing harness, which built its own parallel `effectSerde`), so annotation support was partial by construction. **Fixed P2 bugs**: (1) `RestateIngress.call` (stateless Service) built its serdes WITHOUT the `RedactionCipher`, so a contract with a `Restate.sensitive` field was un-callable through ingress (the encode threw `RedactionCipherMissingError`) even though `objectCall` and the served handler both encrypted it; (2) the Service `call` passed no idempotency key, so a `Restate.idempotencyKey` input field did NOT dedupe a retry (unlike `objectCall`/`objectSend`). Now EVERY adapter — endpoint `handlerOpts`, all ingress paths (`call`/`objectCall`/`objectSend`/`workflowSubmit`/`workflowAttach`/`workflowOutput`/`workflowCall`/`result`/`resolveAwakeable`), the in-handler `callRpc`/`sendRpc`, AND the harness ingress + `stateOf` — consumes the one policy, so an annotation behaves consistently at every public entrypoint and `RestateIngress` carries the optional cipher (resolved from a `RestateRedaction` layer in context). `materialize*` now also VALIDATES annotation placement and FAILS LOUDLY when `Restate.idempotencyKey`/`Restate.sensitive` is applied to the input STRUCT instead of a FIELD (a silent no-op otherwise), or when two fields carry `Restate.idempotencyKey`. Covered server-free (`Annotations.test.ts` placement validation; `options-surfacing.test.ts` materialize-rejection) and against a native `restate-server` (`clients/contract-policy.integration.test.ts`: the invariant matrix over Service × Object × Workflow / call·send·attach — `sensitive` round-trips encrypted, `idempotencyKey` dedupes, terminal error decodes — verified to FAIL on the pre-fix code for both P2 findings). VRS: decision 0020, 02-schema-serde / 05-clients / 09-testing specs. No new dependencies; all 164 package tests green. KNOWN LIMITATION (since FIXED, see the later Fixed entry): the synchronous in-handler `callDescriptor` (used inside `Restate.all([...])`) cannot resolve the ambient cipher at construction time, so a `sensitive`-field redaction on a descriptor-issued peer call was not applied. Now resolved by threading the cipher through `Descriptor.issue` at issue time.
- **@overeng/restate-effect**: Internal `src/` reorganized into ten named subsystem subdirs (`authoring/`, `schema/`, `runtime/`, `error/`, `clients/`, `scheduling/`, `endpoint/`, `observability/`, `testing/`, `admin/`) so the code layout mirrors the VRS subsystem taxonomy. `Endpoint.ts` is split into the error-boundary classification + capability-marker machinery (`error/Boundary.ts`: `classifyOutcome` / `toTerminal` / `provideHandlerCaps` / the `Boundary*` types) and the serving/materialize layer (`endpoint/Endpoint.ts`); the shared bare admin client (`AdminApi.ts`) moves under `admin/`. Pure refactor: `mod.ts` stays the root barrel and the public export surface is unchanged — `.` / `./otel` / `./testing` / `./admin` resolve to the same exported symbols (the `package.json` `exports` map now points at the new internal paths). No behavior change; all 134 tests green.
- **@overeng/restate-effect**: VRS design docs restructured into the ten numeric subsystem dirs (`docs/vrs/01-authoring/` … `10-admin/`), mirroring the `src/` subsystem taxonomy. `docs/vrs/spec.md` is now a thin architecture index (Status + Scope + the architecture diagram + the cross-cutting Deferred + Open-design-question lists + a table linking each subsystem `spec.md`); the §-section bodies moved into each subsystem's `spec.md`, and the requirement bullets distributed into each subsystem's `requirements.md` PRESERVING the global IDs (R01–R39 / A01–A11 / T01–T08 — one ID per subsystem, never renumbered, so every cross-reference still resolves). Root `requirements.md` keeps only the cross-cutting faithful-binding stance + the global Assumptions/Tradeoffs; `vision.md` + `glossary.md` stay whole at root (inherited downward). `docs/vrs/decisions/` renamed to `docs/vrs/.decisions/` (dot-prefixed per `/sk-vrs`; `git mv` preserves history, all 0001–0019 records unchanged in content). External path references updated to the new locations (`README.md`, `docs/guide/*`, `src/schema/{Serde,Annotations}.ts` doc-comment links, intra-VRS cross-links, epic #757). Docs-only — no library surface change.

### Added

- **@overeng/notion-datasource-sync**: Replace legacy body hash pointers with typed `BodyIdentity`/`BodyProjectionPayload` semantics so remote body evidence, rendered content digests, safety, materialization, and OTel body attributes have explicit ownership boundaries and cleaner replay/testing contracts (#766).
- **@overeng/content-address + Notion body sync**: Add reusable content-address primitives (`ContentDigest`, `ContentDescriptor`, canonical JSON hashing, descriptor verification) and use Notion body observation evidence fingerprints for guarded body planning and settlement.
- **@overeng/otelite**: Incubate a coordination-free local OTLP capture tool for E2E and instrumentation tests — effect-utils' first Rust package. Native receiver (HTTP json+proto + gRPC) runs a child with `OTEL_*` env, captures canonical OTLP/JSON, and feeds `inspect` for assertions; a typed Effect wrapper sits on top. M1a lands the Nix build lane (`nix build .#otelite`, `nix run .#otelite`). VRS in `context/otelite/`; epic in #772 (#769).
- **@overeng/otelite-effect**: Add a thin, Effect-native wrapper package around the `otelite` CLI (M9). Shells out via `@effect/platform` `Command` (no `node:child_process`), decodes the CLI's seven `otelite.<name>/v1` JSON schemas with `Schema`, and exposes an `Otelite` `Effect.Service` with `run` (scoped capture of a child) and `inspect` (typed rows or summary per signal). otelite's `sysexits.h` exit-code taxonomy maps onto tagged errors (`OteliteSpawnError`, `OteliteChildFailed`, `OteliteCliError`, `OteliteDecodeError`). The CLI JSON output is the single source of truth — the wrapper never reimplements capture/inspect. Tests run the real nix-built binary (#769, #772).
- **@overeng/notion-core + @overeng/notion-effect-client**: Add shared Notion body-fidelity vocabulary and live Markdown/block-tree observation so downstream packages can distinguish complete remote bodies from lossy endpoint output.
- **@overeng/restate-effect**: Docs-refinement pass + the HTTP error-classification consumer recipe. (1) A new verified example `examples/14-http-error-classification.ts` (+ `src/error/http-error-classification.integration.test.ts`) shows an `HttpClient` call classifying real HTTP outcomes into the typed error channel — 400/403/404 → terminal domain errors, a malformed 200 body → a terminal `MalformedUpstream`, 429/5xx/timeout → the `Restate.retryable` `UpstreamUnavailable` with the 429's `Retry-After` projected — across BOTH transient-retry strategies (Restate's durable STEP retry vs. a caller-visible `backing-off` handler retry), making explicit the journal footgun that a transient outcome must NOT be committed to a `Restate.run` step (a replay re-serves the stale transient instead of re-fetching). Driven end-to-end against a native `restate-server` via a tiny in-process upstream (8 assertions). A guide section in `docs/guide/schema-and-errors.md` teaches the recipe; the spec mention is in `docs/vrs/04-error-boundary/spec.md`. (2) An end-to-end idempotency recipe in `docs/guide/durable-steps.md` threads ONE producer identity (intent-id → Virtual-Object key → Workflow id → send dedupe key) through `Restate.idempotencyKey`, with the different-key-per-layer misuse called out. (3) Docs friction fixes: the `runDescriptor` thunk-vs-`run`-Effect distinction (determinism/durable-steps), the `@effect/platform-node` peer-dep install step beside the first `serve` (getting-started/endpoint), a worked Service+Object-on-one-endpoint `AppR`-union example (endpoint), the durable-promise-key-vs-signal-name clarification (constructs), the named-class `retryable` `retryAfter` projection (annotations). (4) Repointed the 13 guide → `src/` links left dangling by the subsystem-subdir reorg (e.g. `src/cancellation.integration.test.ts` → `src/runtime/cancellation.integration.test.ts`). Docs + one example; no library surface change.
- **@overeng/restate-effect**: Optional/nullable State (migration-blocker) + two typing papercuts (epic #757). (1) **Optional/nullable State** — a state field declared `Schema.optional(S)` (a nullable cursor, e.g. a `highWatermark` watermark) is now expressible AND `stateOf`-readable end-to-end. Restate State is K/V, so an ABSENT key reads back as `undefined` and writing `undefined` REMOVES the key: `State.set(key, undefined)` ≡ `State.clear(key)` in handlers, and the test `stateOf` proxies (`RestateTestHarness.stateOf` / `RestateTestEnv.stateOf`, mock AND real) gained the same `set(undefined)`-removes semantics plus a `clear(key)` method. `State.for` stores the optional field's inner present-value schema for serde (`normalizeStateSchema` strips `undefined`), so a write only ever encodes a present `T` and a read of an absent key returns `undefined` without hitting the serde — ONE pattern that type-checks under BOTH `tsc` (`exactOptionalPropertyTypes`) and the bundler (a bare top-level `Schema.UndefinedOr` handler RETURN is not, since `JSONSchema.make` rejects it; a nullable value belongs in State or a struct field). `AnyImplementation` / `materializeObject` / `materializeWorkflow` widened from `Record<string, Schema>` to `StateSchemas` so an optional-state Object/Workflow materializes. (2) **`domainState` accepts `Schema.optional`** — `RestateScheduled.make` (`Restate.pollLoop`) `domainState` is now `StateSchemas` (shared State-schema handling), so a poll-loop cursor can be nullable. (3) **Typed cycle error channel without a cast** — `CycleEffect`/`ScheduledConfig`/`make` gained a `CycleE` type param tied to `errorSchema`'s decoded type, so the cycle's error channel is `RestateError | CycleE` and a typed cycle `Effect.fail`s its declared error and composes WITHOUT the prior `as unknown as` cast (the composed-daemon example's cast is removed; the loop's `runCycle` absorbs the declared `E` through `classifyOutcome`). (4) **Safe-by-default span projection** — `Restate.annotateSpanFrom(schema, value, pick?)` projects a decoded struct to span attributes and STRIPS every `Restate.sensitive`/`redacted` field (even if explicitly `pick`ed), using the same `findSensitiveFields` walk the serde redaction uses — closing the leak path the free-form `Restate.annotateSpan` (raw primitives, can't detect sensitivity) otherwise left open, so a redacted value can never reach a span by accident. Covered server-free (in-memory `TestContext` nullable State set/get/clear via the real combinators; `RestateTestEnv` mock backend; `annotateSpanFrom` strips sensitive incl. when picked) AND against a native `restate-server` (`RestateTestEnv.real` nullable State end-to-end through `stateOf` + handler; an optional `domainState` cursor advances then clears in a pollLoop). VRS: 01-authoring (optional/nullable State), 02-schema-serde (State value normalization), 06-scheduling (`domainState` optional + typed cycle `E`), 08-observability (`annotateSpanFrom` redaction rule); `docs/guide` constructs/observability/annotations updated. No new dependencies; all 140 package tests green.
- **@overeng/utils**: Shared SSOT helpers used by `@overeng/restate-effect`'s Core S cleanups (additive, dependency-free). (1) `@overeng/utils/node`'s new `net.ts` exports `freePort()` (the single "ask the OS for a free TCP port" helper, previously hand-copied 4× across the playwright config factory's `findAvailablePort` and the restate-effect test harness — all of which shared the same TOCTOU race), plus `freePorts(count)` (allocate N DISTINCT ports as one batch — holds every `:0` listener open until all are read, so the OS cannot hand the same port to two of them, unlike `Promise.all([freePort()×N])`) and `withFreePort(fn, { retries? })` (run a bind-by-number consumer against a fresh port, RETRYING on `EADDRINUSE` — the TOCTOU-closing path for a child process that cannot be handed an already-listening socket). (2) `@overeng/utils` (isomorphic) `formatReasonMessage({ reason, label?, method?, cause? })` is the SSOT for the tagged-error `get message()` body our errors hand-copy (space-join `reason` + optional `[label]` + `(method)` + `: <cause.message>`), preserving the existing `RestateError`/`PtyError` output verbatim. Covered by `src/node/net.unit.test.ts` (6) + `src/isomorphic/string.unit.test.ts` (5).
- **@overeng/restate-effect**: Code-reuse / SSOT cleanups + the `freePort` TOCTOU fix (Core S). (1) Deleted the now-dead `test/restate-server.ts` (subsumed by `./testing`'s productized `startServer`) and the unused `test/test-utils.ts` — both were imported by nothing (~190 lines removed). (2) The four hand-copied `freePort` port-0 helpers (`testing.ts`, the two gone test files, and `@overeng/utils`'s playwright `findAvailablePort`) — plus a 5th in `scheduled-durability.integration.test.ts` — now all consume the single `@overeng/utils/node` `freePort`/`freePorts`. **The shared TOCTOU is fixed where it bites:** the native `restate-server` boot allocates its 3 listener ports via the collision-free `freePorts(3)` batch and the whole boot is RETRIED on a port collision (detected via an `address in use` / `EADDRINUSE` signature in the server's early-exit logs) with a fresh batch — so a co-tenant grabbing a port in the bind-release gap (the `Address in use` parallel-boot flake) just retries instead of redding the lane. Verified by running the integration lane under 8–12 parallel server boots × 8 repeats with zero collision failures. (3) `RestateError.message` now delegates to `@overeng/utils`'s `formatReasonMessage` (behavior-preserving). (4) `Serde.ts`'s inline `new TextEncoder()` byte encoding is replaced with `@overeng/utils`'s `textEncodeToArrayBuffer` (the byte-encoding SSOT). `@overeng/utils` is now a peer + dev workspace dep of `@overeng/restate-effect` (mirroring `notion-effect-client`), so utils's peer surface propagates to the consumer rather than bloating this dependency-light core. No behavior change; all 134 package tests green.
- **@overeng/restate-effect**: Admin / management API (`./admin`) + Molty operating-a-deployment runbook + workflow-id/idempotency-key span stamping (Core M, decision 0018, spec §16). A new OPT-IN `./admin` subpath (dependency-light, like `./otel` / `./testing`) exports a `RestateAdmin` Tag + `layer({ adminUrl, apiKey? })` / `layerConfig()` MIRRORING the `RestateIngress` pattern (decision 0016) but bound to the ADMIN url — every operation an Effect failing with `RestateError({ reason: 'AdminFailed' })`. Operations map 1:1 onto the restate-server admin REST API (verified against 1.6.2, admin-api-version 3): **invocations** `cancel` / `kill` / `pause` / `resume` / `purge` / `purgeJournal` / `delete` (`PATCH|DELETE /invocations/{id}[/{verb}]`) + `restartAsNew({ from?, deployment? })` (restart-from-journal-prefix); **deployments** `registerDeployment` / `listDeployments` / `getDeployment` / `updateDeployment` (`POST|GET|PATCH /deployments[/{id}]`); **introspection** `query(sql, rowSchema)` (a THIN TYPED PASSTHROUGH — the caller supplies the SQL AND the row Schema since the binding does not own the `sys_*` shapes; a decode mismatch → `AdminFailed`) / `queryRaw(sql)` over `POST /query`. The raw HTTP lives in ONE bare-client module (`AdminApi.ts`) that BOTH `./admin` and the harness (`./testing`'s `stateOf` + deployment registration) consume — lifting the harness's previously-duplicated fetch-against-admin code so the two never drift. **Trust boundary** documented prominently: the admin API is unauthenticated by default (never expose publicly; bearer `Redacted` `apiKey` for a secured/Cloud endpoint) and less stable than the SDK protocol (pinned to 1.6.2). **Observability (#5):** the boundary now ALSO auto-stamps `restate.workflow.id` (the Workflow key) and `restate.idempotency.key` (the original-invocation `idempotency-key` header) on the attempt span — so a consumer slices on the end-to-end identity without hand-rolling them; both are identity values, never a redacted FIELD (a small `BoundaryObserver` seam change in `Endpoint.ts` + the `./otel` stamper). Verified server-free (`src/admin.test.ts`: per-op method/path/auth + typed-query decode-failure; `src/observability.test.ts`: the two new attrs via an in-memory `SpanExporter`) and against a real native server (`src/admin.integration.test.ts`: list deployments + a typed `/query` round-trip, QUERY an incident object's State, and surface + cancel a wedged delivery). The Molty runbook recipe is `examples/13-admin-operations.ts` (an `incident` Virtual Object + a `delivery` Workflow that wedges); the guide page is `docs/guide/admin-operations.md`. Version caveats found against 1.6.2: the BULK/BATCH invocation verbs do NOT exist (they 405 — a later-server feature), and a Workflow `run` blocked on a long durable wait reports `status = 'running'` (not `suspended`), so "stuck delivery" is non-terminal-ranked-by-retries. "Admin / management wrappers" is removed from the spec's Deferred list. No new dependencies.
- **@overeng/restate-effect**: Swappable mock⟷real `RestateTestEnv` façade + the eight real-server e2e coverage gaps (decision 0017, spec §11). `./testing` now exports `RestateTestEnv`: ONE `Context.Tag` whose surface is the CONTRACT-ADDRESSED invocation level (`invokeService(contract, method, input)` / `invokeObject` / `submitWorkflow` / `signalWorkflow` / `attachWorkflow` / `stateOf` / `resolveAwakeable` / `kind`), with TWO Layer impls satisfying the same Tag — `RestateTestEnv.mock({ services, appLayer })` (in-process, no journal, no server, ms) and `RestateTestEnv.real({ services, appLayer, alwaysReplay?, disableRetries? })` (a thin wrapper over `RestateTestHarness`) — so the SAME test body (authored ONLY against `RestateTestEnv`) runs on either backend via `it.each(['mock', 'real'])`. The load-bearing property: `invoke*` carries `RestateError | ErrorOf` (the TYPED declared error) on BOTH backends, so `catchTag(DomainError)` compiles AND recovers identically — the mock recovers the typed `E` by round-tripping the failure through the contract's `error` schema (the SAME decode an ingress caller performs on a terminal body). This also made the bound harness `ingress.callTyped`/`objectCallTyped` typed form the default invoke (the precise typed-error union no longer widens; the old escape to the standalone `callTyped` is gone). The mock reuses the package's real building blocks (NOT a re-implementation): the captured `Runtime<AppR>`, the in-memory `makeTestContext` (extended with a shared awakeable registry so a `resolveAwakeable` from OUTSIDE a handler completes a suspended one), the new shared `Endpoint.provideHandlerCaps` per-kind marker provision (the single source of truth, now also used by the real `materialize*` boundary — they cannot drift), the journaled `determinismLayer`, and the boundary's `classifyOutcome`; per-key State `Map`s give object/workflow key isolation for free. The lower-level `RestateTestHarness` + `makeTestContextLayer` primitives stay available (additive). `RestateTestHarness` gains `registerDeployment({ services, appLayer })` (serve + register a SECOND endpoint VERSION on a fresh ephemeral port — multi-deployment upgrade) and endpoint observability wiring on `layer` (`hooks` / `inboundBridge` / `boundaryObserver`). Fills the eight previously-unproven real-server e2e gaps with native-server integration tests: (1) in-handler service→service `Restate.call` / `Restate.send` (cross-invocation); (2) deterministic durable concurrency `Restate.all`/`race` (source-order tuple despite resolution order); (3) multi-deployment version upgrade (two deployments coexist, a new invocation routes to the latest — the full suspend-straddle-upgrade cross-version replay is a documented follow-up); (4) `runExit` saga-compensation (a failed durable step observed as an `Exit` defect → a compensating step); (5) `disableRetries` fail-fast vs retry as an assertion + the `Restate.retryable` + `retryAfter` projection driving retries; (6) `sensitive`-field redaction ON THE WIRE (a raw ingress response holds ciphertext for the field + decrypts back; a missing cipher fails loudly, never plaintext); (7) OTel exactly-once per-invocation metrics + attempt-span reparenting under REAL `alwaysReplay`; (8) `DurablePromise.peek` (non-blocking durable-promise read). A parametrized `src/test-env.integration.test.ts` proves the same body on both backends; the eight gaps live in dedicated `*.integration.test.ts`. VRS: decision 0017, spec §11.6 + the §11.3 layering table (the mock backend is the unit row promoted to a contract-addressed surface), `docs/guide/testing.md` (the `RestateTestEnv` section + mock-vs-real matrix + a consolidated `makeTestContextLayer` options table), and the glossary. No new dependencies.
- **@overeng/restate-effect**: Effect-idiom fixes — replay-aware logging, secured ingress auth, request identity, property-based serde (decisions 0015, 0016; R37–R39). (1) **Logger → `ctx.console` bridge** (decision 0015): a per-invocation `loggerLayer(ctx)` is now provided over every handler effect ALONGSIDE the determinism layer, replacing Effect's default logger so an in-handler `Effect.log*` writes to the invocation's replay-aware `ctx.console` — suppressed during replay (no more re-emitting the same line on every replay/attempt, the bug a `globalThis.console`-backed logger has), level-controlled via `RESTATE_LOGGING`, and stamped with invocation context. The line is formatted by Effect's own `logfmtLogger` (so `Effect.annotateLogs`/spans ride along); only the sink changes. On the CORE `.` export (no `./otel`). The endpoint's own startup log is outside a handler and unaffected. (2) **Secured ingress auth** (decision 0016, R38): `RestateIngress.layer` keeps the literal `{ url }` primitive and gains `apiKey?: Redacted<string>` (+ extra `headers`), sent as `Authorization: Bearer …` so a SECURED / Restate Cloud ingress is reachable (impossible before); the key is a `Redacted` so it never prints. `RestateIngress.layerConfig()` is the `Config`-then-literal wrapper reading `RESTATE_INGRESS_URL` + an optional `Config.redacted('RESTATE_INGRESS_KEY')`. (3) **Request identity** (decision 0016, R39): `EndpointOptions.identityKeys?: ReadonlyArray<string>` (ED25519 v1 public keys) threads into `createEndpointHandler({ identityKeys })` → the SDK's `withIdentityV1`, so the SDK rejects unsigned/unauthorized inbound requests — closing the unauthenticated handler-endpoint hole (pure passthrough). `EndpointOptions.port` now also accepts `number | Config<number>` (resolved on layer acquisition; `layer`/`serve`'s channel becomes `RestateError | ConfigError`), and `RestateOtel.layerConfig` reads `OTEL_SERVICE_NAME`/`OTEL_EXPORTER_OTLP_ENDPOINT` and hands the resolved endpoint to a caller-supplied exporter `build` (the OTLP exporter package stays the consumer's choice — not in the closure). (4) **Property-based serde round-trips** (spec §11.4, now REAL): `@effect/vitest` `it.prop` derives a `fast-check` `Arbitrary` per schema and asserts `deserialize(serialize(x))` equivalent to `x` via `Schema.equivalence` (not `toStrictEqual`) for a plain struct, a transformed schema, an optional state field (`normalizeStateSchema`), and the redaction transform (`encrypt(decrypt(x)) ≡ x` by value, fresh IV per encrypt) — closing the previously-false §11.4 "first-class" claim; JSON-unrepresentable `NaN`/`±Infinity` are excluded via `Schema.Finite` (not round-trippable by design). A parity guard asserts the journaled `Random` overrides every generator method of the default `Random` (catching a future silent determinism hole). The BLOCKING `docs/guide/observability.md` snippet that imported the undeclared `@opentelemetry/exporter-metrics-otlp-http` is fixed to match `examples/09-otel.ts` (`PeriodicExportingMetricReader` + `InMemoryMetricExporter` from `@opentelemetry/sdk-metrics`), and a LOGGING section documents the new bridge. All covered server-free (`src/Runtime.test.ts`, `src/Serde.test.ts`, `src/identity.test.ts`, `src/client-ingress.test.ts`, `src/otel.test.ts`). No new dependencies.
- **@overeng/restate-effect**: Composed `pollLoop` — Retry-After re-arm + webhook wake (decision 0012). `RestateScheduled.make` (`Restate.pollLoop`) now composes two opt-in behaviors. `errorSchema` declares the cycle's error union (annotated `Restate.retryable`/`Restate.terminal`) and routes a cycle failure through the boundary's `classifyOutcome` (the single source of truth): a `retryable` member RE-ARMS the next cycle after its projected `retryAfter` floor (read off the failing instance, e.g. a 429's `retryAfterMillis`) with the cursor AND iteration FROZEN — the same logical cycle retries, not an advance — while a `terminal` member / defect falls to `onCycleError`; `maxRetryBackoffs` (default unbounded) caps consecutive backoffs before demoting to the policy. In the default no-wake shape the backoff is a delayed self-send (generation-bumped, so the pre-armed `fixedDelay` send no-ops), so the per-key write lock is RELEASED during the backoff and `stop` mid-backoff stays prompt (measured ~3ms into a 3000ms backoff). `wake: true` opts the inter-cycle wait into `Restate.race([sleepDescriptor(delay), wake.descriptor])`: each cycle opens a fresh awakeable, persists its id (`wakeId`, a SHARED read-only handler so a webhook can read it under the held lock) and threads the wake reason to the next cycle as `wokenBy`; an ingress `resolveAwakeable` cuts the wait short and the next cycle fires with delay 0. The id ROTATES per cycle; a stale id resolves harmlessly. Documented tradeoff: wake mode HOLDS the write lock during the wait (exclusive `stop`/`start` queue behind it, bounded by the sleep leg) — pair wake with short `retryAfter` floors; the no-wake shape is wedge-free. The two shapes are materialized as two distinct `cycle` bodies. This also fixes a general boundary-correctness bug: `classifyOutcome` now reads the `terminal`/`retryable` annotation PER UNION MEMBER (resolving the matching member for the actual failing error) rather than off the un-annotated `Schema.Union` node — without this every retryable union member silently mis-classified as terminal. Covered server-free (union-member classification in `error-transport.test.ts`) and against a native `restate-server` (`scheduled-compose.integration.test.ts`: Retry-After re-arm + no-wedge stop mid-backoff + terminal-member skip + wake early-fire/rotation/stale-id-harmless; `scheduled-durability.integration.test.ts`: SIGKILL mid inter-cycle wait resumes after restart). The verified composed `notion-watch`-style daemon lives in `examples/12-self-reschedule.ts`; `docs/guide/scheduling.md` has the worked example.
- **@overeng/restate-effect**: In-memory `TestContext` + harness ergonomics + durability lint (#5, decision 0013). `./testing` now exports a FAITHFUL in-memory `RestateContext` (`makeTestContext` / `makeTestContextLayer`) for SERVER-FREE unit tests of handler LOGIC + State transitions — a real in-memory implementation, NOT a stub: State is a real `Map` round-tripped through the same `effectSerde` the handler uses, `ctx.run(name, …)` executes once and MEMOIZES by name (journaled-once: a re-`run` returns the stored value), `ctx.date`/`ctx.rand` are deterministic (seeded), `ctx.sleep` is a controllable no-op, and the layer provides the SAME capability-marker subset the real boundary provides per `handlerKind` (so a `State.set` in a read-only handler is still a compile error). Provide it over the real handler effect and assert on the result AND the State `Map`. It deliberately does NOT model durability/replay, single-writer/per-key concurrency, or cross-handler/cross-invocation effects (`call`/`send`/`reschedule`/delayed self-send/`pollLoop`/cross-invocation durable promises) — documented (JSDoc + README + decision 0013 + spec §11.5) as NOT a substitute for `RestateTestHarness` (the real native server). `withRestateServer({ services, appLayer })` collapses the copy-pasted ~25-line `beforeAll`/`afterAll` scope/ingress boilerplate into `setup`/`teardown` + a `harness()` accessor; the six endpoint-based integration tests (awakeable, cancellation, object, end-to-end, workflow) plus the self-reschedule suite are migrated onto it. `liveSleep` / `withLiveClock` test utils pin an `Effect.sleep` / sub-program to a live `Clock` so wall-clock waits coordinating with the native server elapse under `@effect/vitest`'s virtual `TestClock`. The `overeng/no-non-durable-wait` oxlint rule is enabled on handler `src/` (alongside `no-raw-nondeterminism`), exempting test + harness/testing infra files. Determinism-hazard claims verified at the type level (`capability-inference.types.ts`): a nested journaled op inside `Restate.run` is already a COMPILE error via the run-scrubbing (no new rule needed); gating a `Restate.run` on a journaled `State.get` is deterministic (a non-hazard, left legal). Covered by `src/TestContext.test.ts` (server-free handler/State unit tests against the real combinators).
- **@overeng/restate-effect**: Self-reschedule — durable daemons as a chain of delayed self-sends (#4, decision 0012). `Restate.reschedule({ contract, method, input, delayMillis })` is the typed durable self-send building block: a keyed handler re-arms one of its own handlers via a delayed one-way send (reads `Restate.key`; capability-gated to keyed handlers via `ObjectKey`; journaled → idempotent under replay). `RestateScheduled.make` (alias `Restate.pollLoop`) is a narrow durable recurring-loop primitive: it materializes a Virtual Object that runs ONE bounded `cycle` of the user's work then re-arms via a delayed self-send, so each invocation has a bounded journal (does not grow with cycle count) and crash/restart durability is free (the pending timer survives a restart). Ships `fixedDelay` scheduling, `onCycleError` (default `skipToNext`; also `stopLoop`), stop via `stopWhen`/`maxIterations`/in-cycle `{ stop: true }`, a `start`/`stop`/`status` control surface (`status` is a shared read-only query; the internal `cycle` is `ingressPrivate`), a generation token that invalidates stale delayed timers without a timer handle, and the SAFE re-arm-before-fallible-work ordering (a re-arm journaled before a failure is still delivered, so the loop survives a failing cycle). There is intentionally NO `retryCycle` knob — per-cycle durable retry belongs inside a BOUNDED `Restate.run` (Restate journals a give-up a primitive cannot honestly re-run, and an unbounded `Restate.run` wedges the per-key write lock so `start`/`stop` block). `fixedRate`/`cron`/runtime reconfigure are deferred. The README + `examples/12-self-reschedule.ts` make the p99 latency teaching prominent (a durable daemon uses a one-way send + delayed self-send, never a blocking `call` — measured 18.4s p99). Covered by `src/scheduled.integration.test.ts` against a native `restate-server`: basic recurrence + exactly-once, `maxIterations`/data-driven stop, stop→restart, generation idempotency (a duplicate `start` never overlaps), `skipToNext`/`stopLoop` policies, the `reschedule` building block, and the README example end-to-end.
- **@overeng/restate-effect**: Fix `makeJournaledClock` dropping `Clock.sleep` (Runtime). The journaled per-invocation `Clock` was built via `{ ...Clock.make(), … }`, but `sleep` (and the sync `unsafeCurrentTime*`) live on the Clock PROTOTYPE, not as own-enumerable properties — the object spread silently DROPPED `sleep`, so a bare in-handler `Effect.sleep` threw `clock.sleep is not a function` (it surfaced as a retry loop under load). Rebuilt prototype-preservingly (`Object.assign(Object.create(getPrototypeOf(base)), base, overrides)`) so `sleep` and the `[ClockTypeId]` brand survive while the time reads stay journaled. Regression test added: an in-handler `Effect.sleep` now runs without throwing. Real package defect found under load.
- **@overeng/restate-effect**: End-user documentation for the stable surface (Phase 6). A README covering the mental model, a first Service end-to-end, the three constructs (Service, Virtual Object + typed State, Workflow + durable promises), Schema I/O + the typed error boundary, determinism (journaled `Clock`/`Random`, `Restate.run`, explicit durable waits), durable steps/calls/awakeables + idempotency, cancellation/lifecycle, the endpoint/`serve`, the `./otel` bridge, the `./testing` harness, and an API reference for `.`/`./otel`/`./testing`. Every README snippet is a real compiled-and-run example: the runnable `.ts` files live in `examples/` (covered by `dt ts:check`), and `src/examples.integration.test.ts` drives the example contracts/impls through the `./testing` harness against a native `restate-server` (under `dt check:all`), so a doc snippet that stopped compiling or running fails CI. Grill-in-flux ergonomics (the exact `retryAfter` syntax, automatic durable-combinator-infra-failure-to-defect, awakeables joining `Restate.race`, the self-reschedule helper, a server-free mock context) are left as clearly-marked `TODO(refinement)` stubs for the refinement pass. Docs-only — no library surface change.
- **@overeng/restate-effect**: Completes the v1 Schema-annotation set and the retry surfacing. `Restate.retention({ idempotency?, journal?, workflow? })` on a contract or handler I/O schema is read at `materialize` and mapped to the SDK `idempotencyRetention`/`journalRetention`/`workflowRetention` options (explicit builder `options` win); the R35 service/handler option surface (`inactivityTimeout`/`abortTimeout`/`ingressPrivate`/`enableLazyState`/`explicitCancellation`) is now wired for stateless Services too (handler-level via `HandlerSpec.options`, service-level via the contract's third arg). `Restate.sensitive` (alias `Restate.redacted`) on a struct FIELD is consumed by `effectSerde` as an encrypt-at-encode / decrypt-at-decode TRANSFORM, read ONCE off the pre-transform property signatures (decision 0011): the annotated field is ciphertext on the wire/journal while every other field stays plaintext, round-tripping back to plaintext on decode. The cipher is a pluggable Effect service `RestateRedaction` (`Context.Tag`, a synchronous `{ encrypt, decrypt }` byte cipher) resolved once from the captured runtime context at `materialize`; `aesGcmRedactionLayer(key)` / `aesGcmCipher(key)` provide an AES-256-GCM reference (random IV per encrypt, self-describing `iv‖tag‖ct` layout, `node:crypto`). A schema with a sensitive field but no `RestateRedaction` provided fails with a clear `RedactionCipherMissingError` at encode/decode — never silent plaintext. This is field-level redaction in the serde (the only layer with field structure); the whole-value `JournalValueCodec` stays deferred. Retry surfacing (decision 0006): a typed `retryPolicy` (`maxAttempts`/`initialIntervalMillis`/`maxIntervalMillis`/`exponentiationFactor`/`onMaxAttempts: 'pause'|'kill'`) and an `asTerminalError` hook on service/handler options map to the SDK `RetryPolicy`/`asTerminalError`; `Restate.run` gains an optional `RunRetryOptions` (`maxRetryAttempts`/`maxRetryDuration`/intervals/factor) threaded into `ctx.run(name, action, options)`. Durable retries remain Restate's — `Effect.retry`/`Schedule` are for pure logic only (the `overeng/no-raw-nondeterminism` lint guards). No new dependencies. Covered by server-free unit/contract tests: ciphertext-on-the-wire for the annotated field + plaintext for others + round-trip + missing-cipher failure (XOR and AES ciphers), retention/retry/`asTerminalError` mapped onto the materialized SDK definition options, and `RunRetryOptions` reaching `ctx.run`.
- **@overeng/restate-effect**: Docker-free, Effect-native testing harness behind an opt-in `./testing` subpath export (`RestateTestHarness`). `RestateTestHarness.layer({ services, appLayer, alwaysReplay?, disableRetries? })` is ONE scoped `Layer` that, on acquire, allocates an isolated temp base dir + EPHEMERAL ports for every listener (server ingress/admin/node-to-node AND the SDK endpoint, OS port-0, parallel-safe — R27), spawns the native `restate-server` (binary via `RESTATE_SERVER_BIN` or `nix/restate.nix`) with the optional determinism env (`alwaysReplay` → `RESTATE_WORKER__INVOKER__INACTIVITY_TIMEOUT=0s`; `disableRetries` → `RESTATE_DEFAULT_RETRY_POLICY__MAX_ATTEMPTS=1` + `..._ON_MAX_ATTEMPTS=kill`), polls admin `/health` + partition-readiness, serves the consumer's endpoint (their `appLayer` threaded into the served runtime so handler `R` is satisfied) on its ephemeral port, and registers the deployment; on release (same scope, reverse order) it closes the endpoint → SIGTERM/SIGKILL the server → removes the base dir, surfacing buffered server logs on any startup failure. The harness exposes a typed `ingress` (the `RestateIngress` call surface — Services/Objects/Workflows — pre-bound to the spawned server so tests never thread `RestateIngress`) and `stateOf(contract, key)` → a typed `StateProxy` (`get`/`getAll`/`set`/`setAll`, key+value typed against the contract's `state` block, via `effectSerde` over the Admin API: JSON-mode `/query` hex-decode for reads, `POST /services/{name}/state` byte-array `new_state` for writes) for seeding pre-conditions and asserting post-conditions without going through a handler. No new runtime deps (no Apache Arrow — JSON content negotiation instead). Consumers wire `@effect/vitest` themselves. Covered by a consumer-style integration test (Virtual Object + injected `appLayer`, `stateOf` seed/assert round-trip + key isolation, and an `alwaysReplay` replay-stability run) that gracefully skips when no native `restate-server` is available.
- **@overeng/restate-effect**: OpenTelemetry bridge behind an opt-in `./otel` subpath export (`RestateOtel`). `RestateOtel.layer({ resource, exporter | spanProcessor })` builds ONE OTel `TracerProvider` and registers it as the API global AND installs a global `AsyncLocalStorageContextManager` (via `provider.register()`) — the load-bearing prerequisite, since `@effect/opentelemetry`'s `NodeSdk.layer` registers neither, leaving the hook's `trace.getActiveSpan()` undefined and Effect spans orphaned. The same provider is shared with Effect's tracer, so `Effect.withSpan` and Restate's spans use one provider. `RestateOtel.withOtel(endpointOptions)` attaches `@restatedev/restate-sdk-opentelemetry`'s `openTelemetryHook` service-level on every materialized service (the hook owns the replay-aware `attempt`/`run` spans + inbound W3C extraction) and wires the per-invocation inbound bridge: at handler entry it reads the active attempt span and reparents the Effect program under it (`Tracer.withSpanContext`), so caller → `ingress_invoke` → `invoke` → `attempt` → Effect spans form one coherent trace. Exactly-once-on-replay telemetry is steered through `Restate.run` (the load-bearing seam); an `isReplaying` accessor is also exposed but documented as version-fragile (it reads the SDK's internal `isProcessing`). The core `EndpointOptions` gains dep-light `hooks?`/`inboundBridge?` seams (restate types + a pure transform — no otel dep in the core `.` export). The otel packages are scoped to the `./otel` subpath as peers; the `@opentelemetry/sdk-*` catalog pins are bumped 2.2.0 → 2.7.1 to satisfy `@restatedev/restate-sdk-opentelemetry`'s `@opentelemetry/core >= 2.6.0` peer. Covered by a server-free contract test (in-memory `SpanExporter`) asserting the one-trace parent linkage and exactly-once `run` spans / suppressed replay events.
- **@overeng/restate-effect**: Initial POC of an Effect-idiomatic wrapper around the Restate TypeScript SDK (`@restatedev/restate-sdk` 1.14.5). Provides `effectSerde` (Effect `Schema` ↔ Restate `Serde`, with malformed payloads mapped to a non-retryable `TerminalError(400)`), a per-invocation `RestateContext` `Context.Tag` with durable `run`/`sleep` combinators, declarative Schema-typed service authoring (`RestateService.make`/`handler`), and the endpoint as a scoped (graceful-shutdown) `Layer` plus a `serve` entrypoint. Domain `Schema.TaggedError`s map to Restate `TerminalError`s (no retry, `_tag` metadata) while defects propagate for SDK retry. Covered by a Docker-free integration test against a native `restate-server`. Scope: stateless services only — Virtual Objects, Workflows, awakeables, sagas, and the full OTel trace-context bridge are out of scope.
- **@overeng/restate-effect**: Determinism layer + cancellation↔interruption. Each handler invocation now runs under a journaled Effect `Clock` (`currentTimeMillis`/`currentTimeNanos` ← `ctx.date`; the sync `unsafeCurrentTime*` reads ← a per-attempt frozen base seeded once from `ctx.date.now()` at entry, so they are replay-stable and do not advance mid-attempt) and `Random` (← `ctx.rand`), so default Effect time/random reads are correct-by-construction under replay; durable waits stay the explicit `Restate.sleep`/`timeout`/`race` combinators (no `Clock.sleep` remap). The `overeng/no-raw-nondeterminism` oxlint rule is enabled on source handler code (`src/`, tests exempt). A Restate cancellation now surfaces as an Effect interruption at the next durable await point: `acquireRelease`/`onInterrupt` finalizers and compensations run, the interruption maps to a `CancelledError` (terminal, not retried) rather than a retried defect, and `Request.attemptCompletedSignal` is bridged to attempt-scoped finalization. Adds `Restate.cancel` / `Restate.onCancellation`. Fixes a latent issue where durable-combinator rejections wrapped `CancelledError`/suspension into a retryable `RestateError` defect, causing cancelled invocations to be silently retried.
- **@overeng/genie**: Add `projectionArtifact.json()` for schema-versioned deterministic JSON projections, with generic validation hooks and reusable duplicate-value validators for TS-authored data projected into committed JSON.
- **Notion docs**: Add lightweight package-level VRS requirements/spec docs for `@overeng/notion-core`, `@overeng/notion-effect-schema`, and `@overeng/notion-effect-client`; align the broader Notion VRS docs with implementation reality while keeping package READMEs user-facing.
- **@overeng/notion-core**: Add a dependency-free shared primitive package for Notion API constants, UUID helpers, color/property tuples, property write-class classification, and raw rich-text plain-text extraction.
- **devenv-modules/tasks/changesets**: New shared task module providing `release:changeset:check-bodies`, which rejects malformed Changesets where the YAML frontmatter has no package bumps **and** the body is empty. Catches `changeset add --empty` invocations whose `---\n---\n` placeholder was never filled in. Consume via `(inputs.effect-utils.devenvModules.tasks.changesets { })` in `devenv.nix`. Ported from livestorejs/livestore#1269.
- **@overeng/notion-cli**: Consolidate the Notion command surface under the packaged `notion` binary, including `notion db` replica commands, reusable `notion md` command composition, shared `--version` identity, and Nix/devenv exposure.
- **@overeng/notion-datasource-sync**: Add a standalone Notion datasource sync package with Effect/Schema contracts, a self-contained SQLite replica (`<database-id>.sqlite`), planner/guard/conflict logic, fake and live Notion gateways, NotionMD body integration, one-shot and watch sync surfaces, progress UI, OpenTelemetry instrumentation, and broad fake/live E2E coverage.
- **@overeng/notion-datasource-sync**: Add guarded public SQLite write surfaces for rows, metadata, relations, archive/restore, body pushes, conflict resolution, external URL file attachment staging, view diagnostics, explicit `sync_status.state` buckets, and replica-derived `notion db export`.
- **@overeng/notion-datasource-sync**: Add live demo and verification support for provisioned synthetic Notion fixtures, durable scratch cleanup ledgers, read-after-write body settlement, request/rate-limit telemetry, and credential-free manifest guard coverage.
- **@overeng/notion-md**: Add a public body-only facade for adapters to observe, read, materialize, verified-replace, and settle `.nmd` bodies without depending on sync internals.
- **@overeng/notion-md**: Add path-level `statusPath`/`planPath`/`syncPath` APIs that route file, directory-tree, and flat batch targets through the same contract as the CLI, with library-level guards that reject single-file operations on managed tree members.
- **@overeng/notion-md**: Keep the recursive tree engine behind the path-level API by exporting `syncPath`/`planPath` as the public surface instead of the lower-level `syncTree` operation.
- **@overeng/notion-md**: Include created page identity (`pageId` and `url`) in applied tree `create` results, and document the valid unbound tree `.nmd` shape for local-first page creation.
- **@overeng/notion-md**: Preserve authored directory-tree child indexes when parent bodies contain block-level `<page>` anchors, support URL-less placeholder anchors for newly created children, and fail closed on missing, duplicate, or dangling child anchors.
- **@overeng/react-inspector**: Lineage annotation namespace (#687). New `Lineage` module with `SourceOfTruth | Derived | Projection | Cache | Mirror | External | Computed` tagged union, plus composable companion annotations (`Authority`, `Freshness`, `ForeignKey`). All annotations are self-describing Effect Schemas with ergonomic `pipe`-style constructors (`Lineage.derivedFrom`, `Lineage.cache`, `Lineage.authority`, etc.). The schema-aware renderer surfaces a small superscript glyph next to annotated field names and a dedicated `LINEAGE` / `AUTHORITY` / `FRESHNESS` / `REF` block in the schema tooltip. `SchemaInfo` gains an optional `lineage: LineageBundle` field. Source-field path references in `Derived.from` carry `data-lineage-target` attributes for future jump-to-source wiring. Round-trip-tested via vitest.
- **@overeng/react-inspector**: Map/Set container labels (#686). `Schema.Map({key, value})` renders as `Map<K, V>(N)`, `Schema.Set(T)` as `Set<T>(N)`, plus the `Readonly*` variants. Detected via the `effect/annotation/TypeConstructor` annotation on `Declaration` ASTs.
- **@overeng/react-inspector**: Runtime tagged-union narrowing (#686). When a field's declared schema is `Schema.Union(A, B, C)` of `_tag`-discriminated variants and the runtime value carries a matching `_tag`, the inspector narrows the display (name, tooltip, container label, nested field resolution) to the matched variant. Narrowing happens on every path segment, not just the leaf, so nested fields under a tagged union resolve through the matched variant. `SchemaProvider` gains a `rootData` prop and the context exposes a new `getContextForPathWithValue(path, value)` method.
- **@overeng/react-inspector**: Schema-derived container labels for arrays, records, and tuples (#686). Arrays show `Array<Item>(N)` instead of `Array(N)`, records show `Record<string, Money>` instead of `Object`, tuples show `[string, number, boolean]`. Named array/record schemas (`.annotations({ identifier: ... })`) take precedence over the constructed label. `SchemaInfo` gains a `containerLabel?: string` field. `getFieldSchema` now falls back to `indexSignature.type` so per-field schema resolution works inside records.
- **@overeng/react-inspector**: Rich schema annotation tooltips. Hovering or keyboard-focusing a field name (or struct type badge) now shows a tooltip surfacing `description`, `examples`, `default`, refinement-derived constraints (min/max/length/pattern/format/...), and possible values for `Literal` / `Enums` / `Union`-of-literal / `TemplateLiteral` ASTs. Replaces the previous native `title=` attribute. New exports: `SchemaTooltip`, `SchemaInfo`, `getSchemaInfo`, `getConstraintsFromJSONSchema`, `getPossibleValuesFromAST`. `getFieldSchema` no longer eagerly unwraps refinement/transformation wrappers so user-supplied annotations on those wrappers reach the tooltip.
- **@overeng/genie**: `githubLabels()` runtime primitive for declarative GitHub Issue/PR label management (color, description, deprecation, legacy migrations). Consumed by `mq-cli repo labels` in `schickling/dotfiles`.
- **genie/external.ts**: Shared label catalog exports (`commonLabels`, `mqLabels`, `andonLabels`, `deprecatedDefaults`, `legacyMigrations`) for cross-repo label IaC. Effect-utils self-applies via `.github/labels.json.genie.ts`.
- **@overeng/notion-effect-client**: Add database create/update/archive helpers and switch live Notion integration tests to provision isolated per-run fixtures under `NOTION_TEST_PARENT_PAGE_ID` instead of relying on stale hard-coded workspace page/database IDs.
- **@overeng/notion-md**: Add managed workspace materialization. `sync <dir> --from-remote --root <page-id-or-url>` establishes a workspace from a Notion page tree, and later `sync <dir>` materializes newly discovered remote child pages while reusing the existing guarded one-page sync engine.
- **@overeng/notion-react**: JSX-driven page operations for root `<Page>` and sub-page `<ChildPage>` (#618). Root `<Page>` accepts `title` / `icon` / `cover` and drives `pages.update` on the sync root. `<ChildPage>` becomes a first-class sync boundary with `title` / `icon` / `cover` / `children` / `blockKey`; the sync driver emits and executes `createPage`, `updatePage`, `archivePage`, and `movePage` via `NotionPages.*` with inline block packing (depth ≤ 2, ≤ 100 blocks), tail block ops scoped to the new page, and partial-create rollback on tail failure. Each sub-page is its own sync boundary with its own `blockKey` namespace, and `diff()` descends recursively through retained sub-pages.
- **@overeng/notion-react**: Opt-in `reorderSiblings` on `sync()` (#618 phase 4d). Intra-parent `<ChildPage>` reorder lands via a single `reorderPages` op that the driver realizes with 2N `pages.move` roundtrips through a holding parent (Notion's `pages.move` rejects same-parent, but a trip out and back bumps the page to the end of the original parent's `child_page` block list). Accepts `true` (library auto-provisions and archives a scratch page per sync-with-reorder) or `{ holdingParentId }` (caller-owned lifecycle). Default `false` preserves the pre-4d contract: retained-but-reshuffled siblings still emit same-parent `movePage`, the API rejects, and the driver swallows the validation error.
- **@overeng/notion-cli**: Expose `notion` binary via Nix flake (`packages.${system}.notion-cli`) so consuming repos can add it to their `$PATH` without managing JS module resolution themselves
- **@overeng/pty-effect/client**: Add PTY client support for session tags, `getSession`, `gc`, `updateTags`, `sendData`, `queryStats`, `readRecentEvents`, and live event following
- **@overeng/notion-effect-schema**: Add `NamedIcon` (type: `"icon"`) variant to `Icon` union for native Notion icons (noticons) (#543)
- **@overeng/notion-effect-schema**: Add `NoticonColor` schema for named icon color palette
- **@overeng/notion-effect-schema**: Add `heading_4`, `tab`, and `meeting_notes` block types to `BlockType`
- **@overeng/notion-effect-schema**: Add optional `is_locked` field to `Page` and `DatabaseSchema`
- **@overeng/notion-effect-client**: Add `BlockInsertPosition` tagged union (`after_block`, `start`, `end`) for block insertion
- **@overeng/notion-effect-schema**: Add full `DataSourceSchema` for `GET /data_sources/:id` (properties, parent, database_parent, etc.)
- **@overeng/notion-effect-schema**: Add `PageMarkdown`, `Comment`, `CommentParent`, `View`, `ViewType` schemas
- **@overeng/notion-effect-schema**: Add `RelativeDate` schema type for query filter values (`today`, `tomorrow`, etc.)
- **@overeng/notion-effect-client**: Add `NotionDataSources` module with `retrieve()`, `create()`, `update()`
- **@overeng/notion-effect-client**: Add `NotionComments` module with `create()`, `list()`, `listStream()`
- **@overeng/notion-effect-client**: Add `NotionViews` module with `retrieve()`, `list()`, `listStream()`, `create()`, `update()`, `delete()`
- **@overeng/notion-effect-client**: Add `getParagraphIcon()` helper for tab paragraph block icons
- **@overeng/notion-effect-client**: Add `NotionCustomEmojis` module with `list()` for workspace custom emojis
- **@overeng/notion-effect-client**: Add `NotionPages.getMarkdown()` and `NotionPages.updateMarkdown()` for server-side markdown API
- **@overeng/notion-effect-client**: Add `NotionPages.move()` for moving pages between parents
- **@overeng/notion-effect-client**: Add `markdown` option to `CreatePageOptions` (alternative to `children`)
- **@overeng/notion-effect-client**: Add `is_locked` and `erase_content` to `UpdatePageOptions`
- **@overeng/notion-effect-client**: Add `filterProperties` and `inTrash` to data source query options
- **@overeng/notion-effect-client**: Add strict `.nmd` frontmatter schemas and a storage-size classifier for Notion enhanced Markdown sync metadata
- **@overeng/notion-md**: Add prototype `notion-md` CLI package for self-contained `.nmd` pull/status/push flows with guarded conflict detection and sidecar escalation tests
- **@overeng/notion-md**: Add live Notion E2E coverage for pull/status/push/conflict detection and wire it into the Notion integration CI job
- **@overeng/notion-md**: Expose `notion-md` as a Nix flake package with managed pnpm dependency hash refresh support
- **@overeng/notion-md**: Harden push safety for unknown blocks, Roughdraft review markup, body conflicts with base snapshots, and explicit typed property writes
- **@overeng/notion-md**: Add conservative automatic three-way body merge for non-overlapping line edits, insertions, and deletions
- **@overeng/notion-md**: Replace ad hoc sidecar/base files with strict frontmatter object refs and an Effect-native content-addressed `.notion-md` state store
- **@overeng/notion-md**: Use Notion Markdown `update_content` for proven unique body edits, with guarded `replace_content` fallback and live Notion E2E coverage
- **@overeng/notion-md**: Extract body merge/update planning into a focused pure module with unit coverage
- **@overeng/notion-md docs**: Consolidate scattered research/spec notes into the package-local VRS docs under `packages/@overeng/notion-md/docs/vrs/`
- **@overeng/notion-md docs**: Add package-local usage docs for getting started, CLI workflows, `.nmd` format, sync safety, and troubleshooting
- **@overeng/notion-md**: Add a durable Notion live E2E run ledger and a committed demo `.nmd` fixture synced with the automated Notion showcase page
- **@overeng/notion-md**: Push modeled page metadata from strict frontmatter, including page lock/trash state plus writable icon and cover shapes, and add typed `place`/`verification` property frontmatter values
- **@overeng/notion-md docs**: Fold the remaining VRS design decisions into `spec.md` and remove the companion question log
- **@overeng/notion-md**: Add a TUI Storybook for CLI output states and wire it into the shared Storybook task registry
- **@overeng/tui-stories**: Export `tui-stories` CLI as a Nix package via the flake (#525)

### Fixed

- **@overeng/notion-effect-client**: Make live `NotionBody.observe` fail closed across concurrent remote edits by bracketing Markdown and block-tree reads with page metadata retrieval, retrying unstable observation windows up to three total attempts, and returning `NotionBodyObservationChangedError` when all attempts see `last_edited_time` change (#761).
- **@overeng/notion-md + @overeng/notion-datasource-sync**: Fail closed when a remote Notion Markdown body observation is lossy, including endpoint truncation, empty endpoint bodies with non-empty rendered evidence, unknown blocks, unsupported body inventory, or rendered suffix content omitted after dividers and toggleable headings, so partial bodies are not adopted as clean `.nmd` bases or settled through datasource-sync body guards (#759).
- **@overeng/notion-md**: Adopt block-tree-rendered Markdown, not endpoint Markdown reparsed through CommonMark, as the live pull clean-base body so divider/heading-dense pages do not turn paragraph blocks into `##` headings (#763).
- **@overeng/restate-effect**: Route the standalone blocking durable awaits — the awakeable `promise` and the durable-promise `get`/`peek` — through the shared `awaitDurable` seam (PR #760, two Codex P1 review threads). They previously wrapped EVERY rejection into a `RestateError` defect via `tryPromise + orDie`, bypassing the seam `run`/`sleep`/`timeout`/`all`/`race`/`any` use to classify cancellation/suspension/terminal/infra. The load-bearing fix: a `DurablePromise.reject` (and `Awakeable.reject` / `ingress.rejectAwakeable`) now makes the awaiting `get`/`promise` fail TERMINALLY — the rejection's `TerminalError` terminalizes the awaiter VERBATIM (R33/R34) instead of degrading into a retried infra defect (which Restate retried forever). Cancellation of these awaits now interrupts (finalizers run, mapped to a non-retried `CancelledError`) rather than being wrapped into a retried defect. `awaitDurable` gains an opt-in `'terminal-reject'` mode for this (the `run`/`sleep` infra paths keep a `ctx.run` give-up's `TerminalError` as an infra defect, since a step give-up is infra, not a domain reject). The doc comment that claimed the old code terminalized a reject verbatim (it did not) is corrected to match. Covered by `src/suspension.integration.test.ts` against a native `restate-server`: a `DurablePromise.reject` terminalizes the awaiting `get` and the `run` is NOT retried (the decisive falsifier — the bug retried forever / timed out), plus suspend-and-resume contract tests for the awakeable and durable-promise awaits under `alwaysReplay` + `disableRetries`. VRS: decision 0003, spec §1.3/§9.1.2, glossary.
- **@overeng/restate-effect**: Route the in-handler peer `Restate.call` (`call`/`objectClient`/`workflowClient`) through the shared `awaitDurable` seam, and thread the redaction cipher into descriptor-issued peer calls — closing the third Codex P1 review thread and the descriptor-redaction KNOWN LIMITATION from the contract-invocation-policy change (PR #760). (1) **Suspension/cancellation preserved for in-handler calls**: `callRpc` previously wrapped the `ctx.genericCall` `InvocationPromise` in `Effect.tryPromise`, so an unresolved peer call's SUSPENSION sentinel (the invocation must park and resume on the result) or a `CancelledError` was converted into a `RestateError` defect — degrading a park-and-resume into a defect→retry and swallowing cancellation. It now routes through `awaitDurable` in `'terminal-reject'` mode: a suspension re-throws verbatim (the SDK parks/resumes), a cancellation interrupts, and a callee `TerminalError` terminalizes the caller VERBATIM (R34) instead of becoming a retried infra defect (which Restate retried forever). A peer call carries no typed failure, so `Restate.call`/`objectClient`/`workflowClient` are now honestly typed `Effect<A, never, RestateContext>` (matching the descriptor call path and `Restate.run`). (2) **Descriptor-path redaction**: `Restate.callDescriptor`/`objectCallDescriptor` built their serdes with NO cipher, so a `Restate.sensitive` field on a descriptor-issued peer call inside `Restate.all`/`race`/`any` threw `RedactionCipherMissingError` even with a `RestateRedaction` layer present. The cipher is now resolved at ISSUE time by the effectful combinator and threaded through `Descriptor.issue` (a descriptor builder is synchronous and cannot resolve the ambient cipher itself), so the descriptor path encrypts a sensitive field identically to the direct `callRpc` path (decision 0020). Covered by `src/suspension.integration.test.ts` (a callee that fails terminally terminalizes the caller's call, NOT retried — the decisive falsifier, alongside the durable-promise/awakeable cases) and `src/schema/redaction.integration.test.ts` (a descriptor peer call with a sensitive field round-trips through `Restate.all` under a real `restate-server`). VRS: decision 0003/0020.
- **@overeng/restate-effect**: Fix an intermittent `pollLoop` integration flake (`scheduled.integration.test.ts` "basic recurrence") under high CPU contention. The "exactly-once" check `domain n === control-plane iteration` was sampled mid-flight from two non-atomic ingress reads against a still-advancing loop, so a cycle landing between the reads made `n` lead `iteration` by one. The primitive is correct (cycles are strictly serialized and run exactly once — verified, no extra/duplicate cycle); the assertion was the wrong invariant. Moved the equality check to quiescence (after `stop`, when both counters are frozen) so it stays a full `n === iteration` invariant without any tolerance band or sleep band-aid.
- **@overeng/notion-md**: Guard unified tree sync planning and destructive operations by reporting dry-run moves, blocking missing-file trash unless forced, checking tree `replace_content` races, and documenting the explicit tree/flat-batch CLI contract.
- **@overeng/notion-md**: Deduplicate `--from-remote` materialized paths for colliding Notion titles, strip derived child anchors from tree file bodies while preserving composed baselines, and keep tree sync pinned to the current strict index schema.
- **CI / Nix packages**: Refresh stale pnpm fixed-output hashes for `oxc-config`, `genie`, `notion-cli`, `notion-md`, `megarepo`, `workflow-report`, and `tui-stories`; register `notion-core` in workspace checks; format PR-touched files and keep oxlint fatal for error-level diagnostics while the existing warning backlog is tracked separately.
- **secretspec**: Keep the public repository secretspec limited to environment variable declarations by removing machine-specific secret locator metadata.
- **genie/ci-workflow**: Match managed workflow report PR comments by hidden `stateId` before patching so independent reports sharing the default marker cannot overwrite each other.
- **devenv/tasks/shared/pnpm**: Share live and fixed-output pnpm install policy, cap live install concurrency to match the prepared-workspace builder, and accept Darwin pnpm teardown exits only after materialization is proven complete.
- **@overeng/megarepo**: Keep store/test integration fixtures independent of user tag-signing Git config by creating fixture tags with `--no-sign`, avoid slow filesystem-watch semaphore acquisition in store locks, let `mr store gc --output json` take the final-state path directly, merge `git worktree list` with the on-disk store layout so GC never drops real worktrees from discovery, and run the megarepo Vitest suite with file parallelism disabled because the in-process CLI integration harness mutates global `process.env` and stdio.
- **devenv/tasks/shared/nix-cli**: Run aggregate `nix:check` package hash validations sequentially so CI does not fan out multiple full root-workspace pnpm FOD rebuilds at once on Darwin.
- **nix/workspace-tools**: Tighten pnpm child/network concurrency inside fixed-output pnpm deps builds and cap Darwin Node heap during the install step so macOS CI is less likely to die with an unstructured `Killed: 9` while materializing whole-workspace install roots.
- **@overeng/pty-effect**: Make the server-mode attach/read integration test wait briefly before emitting its marker so slower Linux CI runners do not miss one-shot startup output during initial attach replay.
- **@overeng/notion-datasource-sync**: Keep public SQLite replicas coherent after direct cell edits by routing row changes through canonical CDC, refreshing scalar readback, and failing closed for invalid or unsupported mutations.
- **@overeng/notion-datasource-sync**: Add the missing exported API JSDoc and explicit boolean comparisons that kept `lint` and `devenv-perf` red on PR #683.

- **nix/oxc-config-plugin**: Refresh the `oxc-config` pnpm fixed-output hash so `oxlint` can build again in CI and `lint` / `devenv-perf` stop failing on the stale dependency boundary.

- **nix packages**: Refresh stale pnpm dependency hashes for the Genie, megarepo, tui-stories, and notion-md CLI packages.
- **nix packages**: Refresh the stale `megarepo`, `tui-stories`, `notion-md`, and `workflow-report` pnpm dependency hashes so `nix-check`, `nix-fod-check`, closure-size, and Storybook-report CI jobs use the current dependency closures again.
- **nix packages**: Refresh the stale `notion-cli` pnpm dependency hash after adding the datasource-sync runtime to the packaged workspace.
- **genie/packages**: Include `@overeng/notion-datasource-sync` in the internal package catalog so generated workspace dependency metadata covers the new package.
- **pnpm task**: Bound macOS CI pnpm install heap usage and tolerate Darwin teardown exit 137 only after node_modules materialization is complete.
- **devenv/tasks/shared/pnpm**: Share live and fixed-output pnpm install policy, cap live install concurrency to match the prepared-workspace builder, and accept Darwin pnpm teardown exits only after materialization is proven complete.
- **@overeng/notion-datasource-sync**: Improve watch and remote-adoption reliability by classifying absence candidates with direct retrieval, clearing stale repair markers, honoring gateway retry pacing, and reusing complete checkpoints for lower-latency incremental polling.
- **@overeng/notion-effect-client**: Parse `retry-after` rate-limit header even when `x-ratelimit-remaining` is absent, so rate-limit retry guidance is preserved whenever headers provide it.
- **@overeng/notion-effect-client**: Parse `Retry-After` HTTP-date values as well as seconds and clamp malformed/negative values to zero, so retry backoff avoids invalid or ambiguous rate-limit guidance.
- **@overeng/notion-datasource-sync**: Harden public SQLite `changes` semantics for row create/archive/restore, cell writes, body pushes, metadata/schema/conflict-resolution tables, coalesced repeated edits, ambiguous create outcomes, and fail-closed `people`/`files` direct edits.
- **@overeng/notion-cli**: Gate database export live fixture tests on writable fixture configuration and provision shared Notion integration fixtures before reading `TEST_IDS`, avoiding accidental live API calls with empty IDs when only `NOTION_API_TOKEN` is present.
- **nix/oxc-config-plugin**: Refresh the pnpm dependency fixed-output hash so the devenv shell can realize the oxlint package used by `check:all`.
- **@overeng/tui-react**: Let Effect CLI own Ctrl-C entrypoint handling for `run(App, handler)`. Apps whose action schema includes `Interrupted` now dispatch it during normal Effect interruption finalization, map interrupt-only CLI exits to code 130, and suppress noisy interrupt-only error output in `runTuiMain`.
- **@overeng/megarepo**: Stop store repository discovery from walking internal scratch roots like `tmp` before scanning repos, yield during repository discovery so Effect interruption can propagate promptly, and tighten CLI OTel flush timing so interrupted TTY commands return quickly while still exporting traces.
- **@overeng/megarepo**: Improve `mr store gc --dry-run --output tty` progress UX with early phase updates, heartbeat refreshes, realtime worktree discovery/active-check counts, explicit interrupted output, exit code 130 for Ctrl-C, and more granular OTel spans for removal status checks. GC removal checks now use a single `git status --untracked-files=normal` dirty preflight before the upstream check, avoiding expensive recursive untracked-file enumeration while still failing closed for dirty worktrees.
- **@overeng/megarepo**: Make store GC worktree discovery layout-authoritative across branch, tag, and commit ref roots, and add OTel/log visibility when `git worktree list` cannot be read.
- **@overeng/megarepo**: Avoid recursive `mr fetch --apply --all` hangs when nested apply falls back from a detached branch worktree to an already-created commit worktree.
- **@overeng/megarepo**: Make `mr store gc` data-loss safe for shared stores.
  - Tracks workspace liveness in a store-local registry and protects both active `repos/*` symlink targets and lock-derived `refs/heads/*` / `refs/commits/*` paths.
  - Keeps named `refs/heads/*` and `refs/tags/*` worktrees by default while reclaiming clean unrooted `refs/commits/*` worktrees.
  - Removes the temporary managed/unmanaged store metadata model and the `--include-unleased` GC mode.
  - Forces untracked-file detection during worktree status checks so user/global Git config cannot hide untracked work from GC.
  - Skips worktrees whose git status cannot be inspected unless `--force` is passed, preserving the fail-closed deletion policy.
  - Acquires worktree locks before removal and reports deletion errors as `error` instead of `removed`.
  - Discovers store repositories by `.bare/` presence instead of assuming only `host/owner/repo` paths, traverses discovery concurrently, skips dirty checks for named refs protected by default, streams GC progress through TTY/NDJSON output, avoids recursive worktree-content scans during GC discovery, prunes Git worktree metadata once per repo after safe removals, and adds OTel spans for GC, liveness, and repo discovery.
- **@overeng/react-inspector**: Render the schema display name exactly once in collapsed schema-aware object previews (#684). `SchemaAwareObjectPreview` is now the single owner of the schema title (rendered in the object-description slot, italicized when sourced from a `title`/`identifier` annotation); the collapsed branch in `SchemaAwareNodeRenderer` no longer prefixes a duplicate copy. Fixes `0: Source Origin Summary Source Origin Summary {…}` → `0: Source Origin Summary {…}`.
- **@overeng/notion-cli**: Gate `db dump` live fixture tests on writable fixture configuration and provision shared Notion integration fixtures before reading `TEST_IDS`, avoiding accidental live API calls with empty IDs when only `NOTION_API_TOKEN` is present.
- **nix/oxc-config-plugin**: Refresh the pnpm dependency fixed-output hash so the devenv shell can realize the oxlint package used by `check:all`.
- **devenv/tasks/shared/nix-cli**: Make `dt nix:hash:*` update nested `depsBuilds.".".hash` entries used by `mkPnpmCli`
  - Lets CLI package hash refreshes converge again after repo-root `pnpm-lock.yaml` changes instead of looping until max iterations
  - Restores the intended `dt nix:hash:genie` workflow for package-version bumps that only need the fixed-output deps hash refreshed
- **@overeng/notion-react**: Route `<ChildPage>` title updates through `pages.update` instead of `blocks.update` (#618). Notion's `PATCH /v1/blocks/{id}` rejects a `{ child_page: { title } }` body with `validation_error`; the sync driver now emits `PATCH /v1/pages/{id}` with a properly-shaped `title` property for `child_page` updates.
- **@overeng/pty-effect/client**: Fix flaky timeout in `followEvents` (#577) — `asyncScoped`'s setup ran lazily inside the forked consumer fiber, missing events fired before the fiber started. Replaced with `Stream.asyncPush` (setup still lazy, but `emit.single` is now correctly synchronous for `fs.watch` callbacks). Test updated to watch `session_exit` instead of `session_start`, since `EventFollower.watchFile` starts reading at the current end-of-file when a new session is discovered, making `session_start` unreachable via live following.
- **@overeng/notion-md**: Verify content-addressed object bytes exactly, reject object-store inventory mismatches, and emit structured watch errors as compact JSON lines
- **@overeng/notion-md**: Allow property-only pushes across concurrent remote body edits, clear stale unknown-block storage after destructive replacements, and normalize object-ref path checks cross-platform
- **@overeng/notion-md**: Route watch file events through Effect Platform `FileSystem.watch` while preserving scoped cancellation, polling, debounce, and recoverable sync-error behavior
- **@overeng/notion-md**: Add batch multi-file and recursive folder orchestration for `status`, `push`, and `sync`, including duplicate page-id preflight, per-file result envelopes, bounded concurrency, and multi-file watch mode
- **@overeng/notion-md docs**: Add a recursive workspace demo template that shows multi-file folder sync setup without committing placeholder pages as live targets
- **@overeng/notion-md**: Give CLI subprocess e2e checks explicit timeouts so CI load does not fail the help-path smoke test at Vitest's default 5s limit

### Changed

- **@overeng/restate-effect**: Relocate the VRS design docs (vision/requirements/spec/glossary + the `decisions/` records) into a `docs/vrs/` subdir, separating the design docs from the user-facing README/`examples`. Intra-VRS relative links are preserved (the whole tree moved together); external references (README, `src/Serde.ts`, `src/Annotations.ts`) updated to the new `docs/vrs/` paths. Docs-only — no library surface change.
- **@overeng/restate-effect**: Sharpen the durable surface (refinement Core A). (1) The durable combinators (`Restate.run`/`sleep`/`timeout`/`all`/`race`/`any`/`State.*`/`Awakeable.make().promise`) now have a CLEAN typed `E` — they carry NO `RestateError`. An infra failure is `Effect.die`'d at the single `awaitDurable` seam and classified at the boundary (transient → Restate retries; terminally-failed step → fail), so the no-op `catchTag('RestateError', Effect.die)` is gone and only the inner effect's own domain `E` flows through `Restate.run` (`Restate.run(name, action: Effect<A,Ea,R>) → Effect<A, Ea, R'>`). `Restate.run` journals the raw success value (not a wrapped `Exit`). Adds `Restate.runExit(name, effect) → Effect<Exit<A,E>>` as the opt-in observe form for compensation/sagas (the infra failure is a `Cause.Die` carrying the `RestateError`). The `IngressFailed` client surface (`Restate.call`/`send`, ingress) keeps its typed `RestateError` (it pairs with the typed decode helper). Aligns the impl with decision 0003. (2) Every durable op now exposes a DESCRIPTOR for the deterministic combinators: `Awakeable.make(S).descriptor`, `Restate.callDescriptor`/`objectCallDescriptor`, alongside the existing `runDescriptor`/`sleepDescriptor`/`DurablePromise.for(S).getDescriptor` — so an awakeable joins `Restate.all`/`race`/`any` in journal-source order (replacing the in-process `Effect.raceFirst` workaround that lost determinism). (3) `Restate.retryable({ retryAfter })` accepts `number | Duration | ((error) => number | Duration | undefined)` — a static shorthand OR an instance projection read off the actual failing error at the boundary (e.g. a 429's `e.retryAfterMillis`), mirroring `idempotencyKey`. (4) Papercuts: `State.for` accepts `Schema.optional` fields; the `StateRead`/`StateWrite`/`DurablePromise` capability markers carry descriptive brands so a violation reads like the missing capability; the boundary validates a thrown failure against the declared `error` union (`Schema.encodeUnknownEither`) and surfaces a non-match as a defect (no silent mis-encode). (5) Type frictions: a heterogeneous-`AppR` `services` array now typechecks (the `_Implementation._AppR` phantom is covariant + `layer`/`serve` infer the `AppR` UNION via an `AppROf<Services>` extractor); `./testing` `harness.ingress.*` preserves the precise per-call typed-error + success channels (the `BindLast` wrapper that collapsed `ErrorOf` is replaced by explicit generic `BoundIngress` signatures derived from the `*Of` helpers). VRS: decisions 0003 + 0011 and spec §5/§6/§6.2/§7/§13 updated; README/`examples` `TODO(refinement)` stubs for retryAfter, the clean-error-channel ergonomics, and awakeables-in-`race` filled with verified examples. No new dependencies; `dt check:all` green.
- **@overeng/utils + @overeng/notion-md + @overeng/notion-datasource-sync**: Deduplicate SHA-256 content hashing onto the shared isomorphic `sha256Hex` helper in `@overeng/utils`, dropping direct `node:crypto` use in `notion-md` (`sha256Digest`) and `notion-datasource-sync` (`hashStoreBytes`). Output is byte-identical; the hashing is now browser-capable.
- **@overeng/utils + @overeng/notion-md + @overeng/notion-datasource-sync**: Extract one canonical `titleSlug` into `@overeng/utils/isomorphic/string` and converge both Notion workspace path generators onto it. `notion-md` adopts the NFC-normalized, 120-char-capped slug semantics for newly generated page paths (existing manifest-recorded paths are unaffected).
- **@overeng/notion-effect-client + @overeng/notion-cli + @overeng/notion-md + @overeng/notion-datasource-sync**: Consolidate Notion token resolution into a single `resolveNotionToken` (returning `Redacted`) plus a `NotionTokenMissing` tagged error in `@overeng/notion-effect-client`, replacing three independent resolvers across the `notion`, `notion md`, and `notion db` CLIs. The accepted env-var set (`NOTION_API_TOKEN` → `NOTION_TOKEN`) is now a single source of truth.
- **@overeng/notion-effect-schema**: Unify the markdown and HTML rich-text annotation formatters behind one shared ordering combinator (`applyAnnotations`); output is unchanged.
- **@overeng/notion-effect-schema + @overeng/notion-effect-client**: Reuse dependency-free Notion constants, literal tuples, UUID helpers, property classification, and raw rich-text helpers from `@overeng/notion-core` while preserving existing schema/client public exports.
- **@overeng/notion-effect-schema + @overeng/notion-datasource-sync**: Promote the bidirectional Notion property-value codec and write-class taxonomy into `@overeng/notion-effect-schema` (`CanonicalPropertyValue`, `makeCanonicalCodec({ hash })`, `decode`/`encodeCanonicalPropertyValue`, `propertyWriteClassFromType`, `Canonical{Decode,Encode}Error`), with hashing injected by the caller so the schema package owns the data semantics while `notion-datasource-sync` keeps the hashing policy. nds now delegates property decode/encode to it and keeps only its sync-domain projection/guards; the canonical id brands (`Notion.PropertyId` / `Notion.PageId` / `Notion.PropertyName`) live in the schema package and are aliased by nds. Canonical JSON output — and therefore content hashes — is byte-identical.
- **@overeng/notion-effect-client + @overeng/notion-datasource-sync**: Consolidate Notion API mechanics into the client. Add an optional composable request-throttle layer (`NotionThrottle` / `NotionThrottleLive`, token-bucket via `RateLimiter`, applied once per logical request rather than per retry) and move the rate-limit classification (`isRateLimited` / `retryAfterMillis`) onto `NotionApiError`. The datasource-sync gateway drops its hand-rolled global throttle and configures the client layer instead, with production wiring keeping the existing 3 rps. Replace the unused `paginatedStream` with a `paginate` helper over the mapped `PaginatedResult` shape (optional initial cursor + item/page emit modes) and migrate all cursor-pagination sites (client `views`/`databases`, gateway views/rows/page-property) onto it.
- **genie/external.ts**: Drop `injectWorkspacePackages: true` from the shared `commonPnpmPolicySettings`. The setting is required for effect-utils' own pure Nix/FOD package closure model, but downstream consumers without that model lose visibility to workspace `devDependencies` / `peerDependencies` at type-check time once pnpm injects copies of each workspace package without their dev/peer closures (see livestorejs/livestore#1271). The setting now lives on `commonPnpmWorkspaceData` in `genie/internal.ts`, so effect-utils' own root yaml still materializes injected workspace packages while peer repos spreading `commonPnpmPolicySettings` keep pnpm's default symlink resolution. Repos that want injection can add `injectWorkspacePackages: true` explicitly in their own `pnpm-workspace.yaml` (or extend `commonPnpmPolicySettings` with it).
- **@overeng/notion-datasource-sync docs**: Compact standalone VRS decision records into the active requirements/spec/capability-boundary documents and remove release/checklist artifacts from the VRS companion docs.
- **@overeng/notion-datasource-sync + @overeng/notion-md**: Route the NotionMD-backed body adapter through the public body facade and centralized datasource-sync sidecar helpers, removing direct `.nmd` parsing/materialization glue from datasource-sync while preserving body-only semantics.
- **@overeng/notion-effect-client / @overeng/notion-md**: Share canonical `.notion-md` object-store paths, sync-state paths, object refs, and storage-size thresholds from the NMD schema layer so local metadata decisions derive from one source of truth.
- **@overeng/notion-md**: Breaking CLI simplification: collapse the user-facing page workflow around `sync` and `status`; replace the old explicit `pull` / `push` entrypoints with `sync <page-id-or-url> <file.nmd>` for bootstrap and guarded `sync <file.nmd>` for reconciliation.
- **@overeng/notion-md**: Remove legacy compatibility paths for batch `push` and local-first `page_id: null` page creation; existing Notion pages must be materialized with `sync <page-id-or-url> <target>`.
- **@overeng/pty-effect/client**: `spawnDaemon` now delegates to `@myobie/pty.spawnDaemon` instead of duplicating the daemon spawn pipeline. The Bun-on-Node case is routed through upstream's new `launcher` option (still honors `NODE_BIN`). Eliminates a divergent in-house spawn path so consumers automatically inherit upstream improvements such as bundle-safe spawn (myobie/pty#38). Public API and `PtyDaemonSpec` schema unchanged.
- **@overeng/notion-react**: `<Page>` and `<ChildPage>` accept `icon={null}` and `cover={null}` as explicit clear sentinels (#618). Dropping the prop is still "no claim" (preserves server state); passing `null` emits `pages.update({icon: null})` / `pages.update({cover: null})`. On a fresh page with no prior icon/cover, `null` is a no-op.
- **@overeng/notion-react**: Same-parent `<ChildPage>` creates are now sequential — JSX order is preserved 1:1 on the server (#618). Parallel `pages.create` under a common parent yields nondeterministic `child_page` ordering; the driver issues sequential POSTs so no post-create re-fetch is needed. T08 (formerly "concurrent sibling-page order is not authoritative") is now a normative invariant; the deferred `ensureSiblingOrder` sync option is dropped.
- **@overeng/notion-react**: `CACHE_SCHEMA_VERSION` bumped `2 → 3` to accommodate per-page cache subtrees (#618). v2 caches fall through the existing `"schema-mismatch"` cold path — transparent, no caller action required. The first sync after upgrade may emit one spurious metadata update per sub-page as response-normalized title/icon/cover is recomputed.
- **genie/ci-workflow**: Unify Vercel CI job generation behind a single `vercelDeployJobs()` helper
  - Removes the separate static-job and job-merge helpers now that task-level deploy mode is already unified in `vercel.nix`
  - Lets consumers mix build-mode and static-mode deploys in one project list and attach per-project pre-deploy setup like Vercel git-author configuration
- **deps**: Upgrade `@myobie/pty` from the old git-pinned fork to the published `0.8.0` release line
- **@overeng/notion-effect-client**: Upgrade Notion API version from `2022-06-28` to `2026-03-11`
- **@overeng/notion-effect-schema**: Remove `archived` field from `DatabaseSchema`, `Page`, and `Block` schemas (replaced by `in_trash` in API 2026-03-11)
- **@overeng/notion-effect-client**: Replace `after` parameter with `position` object in `AppendBlockChildrenOptions`
- **@overeng/notion-effect-client**: Replace `archived` with `in_trash` in `UpdatePageOptions` and `archive()` method
- **@overeng/notion-effect-client**: Remove `archived` from `TypedPage` interface (use `inTrash` instead)
- **@overeng/notion-effect-client**: Add named icon variant to `CreatePageOptions` and `UpdatePageOptions` icon types
- **@overeng/notion-effect-client**: Unify file upload API version with shared `NOTION_API_VERSION` constant
- **@overeng/notion-effect-client**: Update search filter from `'database'` to `'data_source'` (API 2025-09-03+ change)
- **@overeng/notion-effect-client**: Migrate database query from `/databases/:id/query` to `/data_sources/:id/query` (`databaseId` → `dataSourceId`)
- **@overeng/notion-effect-schema**: Add `data_source_id` parent variant to `PageParent` schema
- **@overeng/notion-effect-schema**: Add `data_source_id` parent variant to `BlockParent` schema for blocks returned from data-source-backed pages.
- **@overeng/notion-effect-schema**: Rename `DataSource` → `DataSourceRef` for lightweight reference in `DatabaseSchema.data_sources`
- **@overeng/notion-effect-client**: Widen `SchemaHelpers` to accept both `DatabaseSchema` and `DataSourceSchema`
- **@overeng/notion-md**: Use `NOTION_API_TOKEN` as the only Notion credential environment variable across code, docs, tests, and SecretSpec

### Fixed

- **genie/ci-workflow**: Add a shared step decorator for job-local private Cachix read auth
  - Creates a per-step netrc file and appends `netrc-file` to `NIX_CONFIG` instead of relying on runner-global Determinate state
  - Lets downstream repos decorate `devenv` and deploy run steps without exposing the Cachix token to unrelated actions
- **devenv/tasks/shared/vercel.nix**: Preserve dotfiles when packaging static prebuilt output for Vercel deploys
  - Copies `staticDir/.` into `.vercel/output/static/` instead of globbing `staticDir/*`, so hidden assets and config files are not silently dropped
- **@overeng/notion-effect-client**: Raise user integration-test timeouts to tolerate current Notion API latency in CI
- **@overeng/notion-cli**: Fix introspection pipeline to read properties from data source (API 2026-03-11 no longer returns properties on `GET /databases/:id`)
- **@overeng/pty-effect/client**: Keep daemon spawning on PTY's published client API while updating the wrapper to the current session/tag/event surface and preserving attach runtime context

### Changed

- **deps**: Upgrade all Effect ecosystem packages (+2 minor each): `effect` 3.19.19 → 3.21.0, `@effect/platform` 0.94.5 → 0.96.0, `@effect/ai` 0.33.2 → 0.35.0, and 12 other `@effect/*` packages to latest
- **nix**: Update `tsgo` flake input to `Effect-TS/tsgo@24a8a96` (2026-03-30)
- **nix/workspace-tools**: Replace committed per-package normalized pnpm lockfiles with direct staged installs from the authoritative root lockfile
  - Keeps the full pnpm 11 multi-document root lockfile intact inside staged workspaces instead of checking in derived `pnpm-lock.normalized.yaml` files
  - Keeps `manage-package-manager-versions=false` so pinned Nix pnpm builds stay sandbox-safe without self-bootstrapping another pnpm under `$HOME`
  - Removes first-party `pnpm-lock.normalized.yaml` artifacts from `genie` and `megarepo`

### Fixed

- **devenv/tasks/shared/ts.nix**: Make `ts:check:strict` inherit repo-local `ts:check.after` dependencies
  - Preserves consumer generators like `contentlayer:build` when strict typecheck is used as the CI gate
  - Prevents downstream repos from regressing when they already extend `ts:check` with extra build prerequisites
- **genie/external**: Export the shared `@effect-atom/atom` peer-version allowlist in megarepo pnpm policy
  - Keeps downstream repos on `strictPeerDependencies: true` while allowing the Effect version ranges already used inside effect-utils itself
  - Prevents consumer workspace installs from failing on the known pre-1.0 peer ranges declared by `@effect-atom/atom`
- **genie/external**: Export the full shared patch registry to peer repos
  - Adds the `node-pty@1.1.0` patch to `createPnpmPatchedDependencies()` / `pnpmPatchedDependencies()`
  - Unblocks composed-root `pnpm-workspace.yaml` generation in downstream megarepos that import `@overeng/utils`
- **@overeng/genie**: Use cwd-relative lock directory instead of shared `/tmp/genie-locks/` to fix `EACCES` errors in multi-user CI environments (#520)
- **@overeng/tui-react**: Format timeline timestamps as human-readable durations (e.g. `6m 18s / 16m 21s`) instead of raw seconds (`377.9s / 980.6s`) in `TuiStoryPreview` (#472)
- **devenv/tasks**: make warm shell bootstrap commit-scoped and remove `ts:emit` from shell entry
  - Adds an outer `setup:auto` cache so warm `devenv shell` skips unchanged bootstrap work instead of traversing `pnpm:install`, `genie:run`, and `mr:apply` on every entry
  - Switches shell bootstrap from `mr:sync` to initial `mr:apply` so a fresh worktree is normalized without fetching on every shell
  - Replaces setup fingerprint tool-version probes with resolved tool-identity hashing so warm shells do not pay `pnpm`, `genie`, or `mr` CLI startup just to validate unchanged setup inputs
  - Speeds up warm task status paths by using direct `mr status`, fingerprint-based `genie:run` caching, a one-process `pnpm:install` projection hash that preserves the previous structural guarantees, and a `ts:emit` graph that excludes `noEmit` references at emit time
  - Hardens the fast paths by making the outer cache only track setup inputs while each task still verifies its own outputs before skipping
- **devenv/otel**: update `devenv` to the upstream `v2.1` tag and move OTEL shell-entry notices onto `devenv.messages`
  - Resolves OTEL mode, dashboard sync, and Grafana trace-link construction in a dedicated shell-entry task instead of ad-hoc `enterShell` output
  - Auto-displays the OTEL shell-entry message through upstream task messages while keeping `otel-trace` as a lightweight re-open helper
  - Scrubs ambient task trace context before emitting `devenv/shell:entry` so the shell root span cannot self-parent or collide with later `dt` root spans
  - Emits `devenv/shell:entry` via the pinned store path for `otel-span` so tracing still works before `enterShell` PATH mutations are fully visible
- **@overeng/genie**: Validate GitHub Actions `runs-on` labels before emitting workflow YAML
  - Fails `genie` when workflow jobs serialize non-string, empty, or stale placeholder runner labels like `null` / `...=undefined`
  - Prevents CI helper API drift from silently generating invalid workflow files that only fail later in GitHub Actions
- **@overeng/megarepo**: Harden store against broken worktree remnants (#423)
  - `hasWorktree` now checks for `.git` file existence instead of just directory existence, so broken partial worktrees are properly detected and recreated
  - Lock-protected worktree creation cleans up broken directory remnants and prunes stale git worktree bookkeeping before recreating
  - Fix semaphore creation race in `StoreLock` using `SynchronizedRef` for atomic get-or-create
- **flake / nix/workspace-tools**: Document and regression-test strict downstream reuse of effect-utils' canonical nixpkgs input
  - Adds downstream flake-input and `devenv` fixture coverage for standalone and `repos/effect-utils`-prefixed consumers
  - Makes the intended contract explicit: downstream repos should follow `effect-utils/nixpkgs` instead of overriding effect-utils to their ambient nixpkgs
- **@overeng/megarepo**: Skip pre-flight hygiene checks in apply mode (#423)
  - Apply mode self-heals all store issues (missing bare repos, broken worktrees, ref mismatches)
  - Eliminates races in `--all` mode where concurrent nested syncs modify shared store state while sibling pre-flight checks observe it
  - Simplifies `runPreflightChecks` to lock-mode-only (removes `mode`/`commitMode` parameters and exception lists)

- **devenv/tasks/shared/nix-cli**: Update multiple stale Nix FOD hashes per `dt nix:hash:*` iteration
  - Adds `nix build --keep-going` to surface all fixed-output hash mismatches from one build
  - Parses and applies multiple reported hash updates in one pass instead of only the first mismatch
  - Adds regression coverage for mixed main-hash and local-dependency hash updates
- **nix/workspace-tools/mk-pnpm-deps / mk-pnpm-cli / oxc-config-plugin**: Switch Nix-contained pnpm builds to precomputed relocatable install trees
  - Prepares the staged workspace install tree once inside the fixed-output derivation instead of restoring a vendored pnpm store and rerunning `pnpm install` in downstream builds
  - Normalizes pnpm's absolute-path and timestamp metadata so the prepared tree stays deterministic across repeated builds
  - Restores the prepared tree into the real workspace and relocates pnpm path placeholders before Bun-based build steps run
- **nix/workspace-tools/mk-pnpm-deps**: Drop pnpm bookkeeping metadata from prepared install trees
  - Removes `.modules.yaml` and `.pnpm-workspace-state-v1.json` from the archived prepared tree because downstream Nix builders restore the tree and go straight to Bun instead of rerunning pnpm
  - Eliminates the remaining runner-specific pnpm metadata nondeterminism that was still flipping prepared-tree hashes across CI environments
- **nix/workspace-tools/mk-pnpm-cli**: Keep `pnpm` available in prepared-tree build environments
  - Restores `pnpm` to `nativeBuildInputs` so downstream packages can keep using `pnpm exec ...` in `postBuild` hooks after the install tree is precomputed
  - Gives pnpm a writable HOME and disables package-manager self-bootstrap in the builder so `pnpm exec` remains sandbox-safe and does not try to install a different pnpm version under `/homeless-shelter`
  - Fixes downstream CLI packages with asset builds layered on top of `mkPnpmCli`, such as `op-proxy` and `factory`
- **CI workflow / genie/ci-workflow**: Evict cached pnpm-deps outputs before CI jobs resolve `oxlint-npm`
  - Avoids stale fixed-output pnpm cache entries masking the validated prepared-install-tree hash on CI runners
  - Applies the cache bust to each job that resolves the shared Nix toolchain so `nix-check` and the faster task jobs agree on the same fresh deps output
- **@overeng/genie**: Fail `genie --check` when inherited peer deps use ranged local install versions
  - Allows ranged `peerDependencies`
  - Requires explicit local install versions in `dependencies` / `devDependencies` / `optionalDependencies`
- **@overeng/megarepo**: Handle stale locked commits during `mr sync --pull`
  - Prevents recursive sync from aborting when nested pinned members reference commits that no longer exist
  - Allows `mr sync --pull --force` to recover pinned branch members by resolving the tracked ref head
  - Adds regression coverage for recursive `--pull --all` with nested stale pinned lock entries
- **devenv/lint**: Adopt `execIfModified` negation patterns and drop the obsolete full-workspace lint install dependency
  - Excludes vendored/generated trees like `node_modules` during lint cache invalidation
  - Keeps `oxlint` install-free by using the bundled Nix JS plugin instead of the source plugin path
  - Retains the package-local `genie` install dependency because `genie --check` still runs via the repo's source-mode CLI
- **devenv/tasks/shared/check.nix**: Give aggregate check tasks explicit no-op commands so `devenv tasks run check:*` actually traverses their dependencies
  - Prevents current `devenv` from treating `check:quick` / `check:all` as skipped `No command` wrappers
  - Restores the intended shared quick-check entrypoint for downstream repos
- **Effect TypeScript tooling**: Pin the exported `effect-tsgo` flake input back to the last known-good upstream revision
  - Reverts the `tsgo` flake lock refresh after confirming `Effect-TS/tsgo@df2eaaa` currently fails to build its own `effect-tsgo` package
  - Keeps downstream `devenv` shells green until the upstream patch set catches up again
- **nix/workspace-tools/mk-pnpm-cli**: Build pnpm CLIs from filtered aggregate-root workspaces instead of package-level deploy closures
  - Moves patched dependency path discovery out of Nix evaluation and into the staging derivation
  - Preserves lockfile-driven patch staging for root and external install roots without recursive eval-time YAML walks
  - Unblocks downstream composed flake evaluation that was previously overflowing in `parsePatchedDependencyPaths`
  - Stages the target package and its workspace closure under one canonical root workspace
  - Installs dependencies at that staged root with the same aggregate lockfile model used by local dev
  - Compiles the target entrypoint with Bun from the staged package directory, reducing coupling to bespoke deploy-time workspace surgery
  - Narrows pnpm deps fetching to the staged root lockfile, closure package manifests, and referenced patch files
  - Removes legacy deploy-specific behavior and normalizes the store against the staged aggregate workspace input
  - Keeps the smoke harness focused on real Nix builds of the `genie` and `megarepo` packages
- **@overeng/tui-react**: Add `@types/react` and `@types/react-reconciler` to peer dependencies
  - Consumers need these type packages to type-check the `.tsx` source exports
- **devenv/tasks/shared/vercel.nix**: Export deploy URLs as task output env vars and fail fast when URL extraction fails
  - Captures Vercel CLI output inside task execution and extracts the deployment URL deterministically
  - Writes `VERCEL_DEPLOY_URL` and `VERCEL_DEPLOY_URL_<DEPLOYMENT_NAME>` via `DEVENV_TASK_OUTPUT_FILE`
  - Enables CI callers to consume deploy URLs from structured task output instead of brittle log scraping

### Changed

- **devenv/tasks/shared/ts-effect-lsp.nix**: document the tracked future unification of the standalone Effect LSP task with `ts:check`
  - Adds a linked TODO for collapsing the separate task once the main workspace TypeScript check becomes `Effect-TS/tsgo`-backed
- **@overeng/genie**: tighten pnpm workspace SSOT around package seeds
  - Removes `extraPackages` from `pnpmWorkspaceYaml.root(...)` and the matching `additionalMemberPaths` graph helper escape hatch
  - Removes committed package-level `pnpm-workspace.yaml` projections in favor of internal build-time package closures
  - Removes `pnpmWorkspaceYaml.manual(...)` and `packageJson.aggregate(...)`; all root projection now goes through `pnpmWorkspaceYaml.root(...)` and `packageJson.aggregateFromPackages(...)` with explicit `repoName`
  - Adds `extraMembers` as an exceptional escape hatch for non-genie-managed workspace members (e.g. standalone examples in livestore) — prefer real package generators over `extraMembers` whenever possible
  - Stops `genie/external.ts` from depending on internal workspace-graph helpers and documents the seed-only aggregate model
- **Effect TypeScript tooling**: switch local language-service integration to Nix-provided `effect-tsgo`
  - Repoints the dev environment to upstream `Effect-TS/tsgo`
  - Renames generator helpers/comments to describe the current tsgo-based model
  - Keeps the `@effect/language-service` tsconfig plugin entry only as the current upstream tsgo configuration channel
- **pnpm/dev workspace**: Switch dev installs to a generated repo-root hoisted pnpm workspace
  - Adds generated root `package.json` and `pnpm-workspace.yaml` with explicit workspace members
  - Makes `pnpm:install` own the repo-root install state and keeps the repo-root `pnpm-lock.yaml` as the only authoritative lockfile
  - Updates package-scoped task execution to use `pnpm exec` so Vitest, Storybook, and Vite resolve against the active workspace topology
  - Derives package closures for Nix/tooling at build time instead of committing package-level `pnpm-workspace.yaml` files
  - Clarifies in the install spec that the current symlinked `repos/*` Megarepo realization keeps imported members on a cross-repo `link:` boundary rather than making them aggregate-root workspace importers
- **@overeng/utils**: Make Storybook `viteFinal` typing opt-in generic for linked Vite workspaces
  - Keeps the default helper API free of foreign Vite types
  - Lets consumers opt into their own local `vite` config type when they need a typed `viteFinal` hook
- **devenv/tasks/shared/vercel.nix**: Switch to prebuilt deploy mode (`vercel pull` -> `vercel build` -> `vercel deploy --prebuilt`)
  - Replaces direct `vercel deploy <dir>` with local prebuilt workflow for deterministic deploys
  - Replaces `path`/`outputDir` deployment config with `cwd` (defaults to `"."`)
  - Adds `vercel pull` step to fetch project settings and env for the target environment
  - Adds `vercel build` step to produce `.vercel/output` locally before deploying
- **@overeng/genie / @overeng/notion-cli**: Source inherited install-time dependency versions from the Genie catalog instead of copied peer ranges
  - Keeps `peerDependencies` ranged for consumers
  - Makes the catalog the single source of truth for concrete local install versions

### Added

- **devenv/tasks/shared/ts-effect-lsp.nix**: add reusable `ts:effect-lsp` tsgo diagnostics task
  - Exports `effect-tsgo` from the flake package set for downstream devenv consumers
  - Keeps the task standalone so repos can opt into Effect diagnostics without conflating them with stylistic lint
- **@overeng/genie**: Added `githubAction` runtime generator for type-safe `action.yml` generation
- **docs/bun**: Document the upstream nested-workspace `patchedDependencies` blocker and link the Bun issue
- **docs/bun**: Note the Bun-only local workspace fork workaround for patched dependencies
- **@overeng/effect-rpc-tanstack**: Add custom fetch transport support to `layerClient`
  - Allows SSR callers to reuse Effect's built-in `FetchHttpClient` with an injected fetch implementation
  - Adds `fetchFromWebHandler(...)` for adapting colocated web handlers to fetch-compatible transport
  - Avoids app-local reimplementation of Effect HTTP request body/stream handling
- **docs/node-modules-install**: Clarify the pnpm GVS requirement for single-instance JS/TS dependency identity and add install-performance requirements

### Removed

- **devenv/tasks/shared/ts.nix**: remove the legacy `ts:patch-lsp` patching flow from the shared TypeScript task module
  - Drops the `lspPatchCmd`, `lspPatchAfter`, and `lspPatchDir` parameters from the exported shared task API
  - Removes stale shell-entry and OTEL references to `ts:patch-lsp`
- **devenv/tasks/shared/setup.nix**: Remove `setup:opt:*` wrapper tasks and `setup:optional` gate
  - Optional tasks now use native `@complete` dependency suffix instead of nested `devenv tasks run` wrappers
  - Eliminates 6x shell re-evaluation, ~5.9s trace gap, fork-bomb guards, and filesystem locks
  - The workaround for `cachix/devenv#2480` is no longer needed since we use `devenv shell` (not direnv)
- **nix/workspace-tools**: Remove compatibility-only Nix surface from CLI builders/tasks
  - Drops the dead `packageJsonDepsHash` argument from both `mk-pnpm-cli` and exported `mk-bun-cli`
  - Removes the deprecated `devenvModules.tasks.git-hooks-fix` export and deletes its module

### Fixed

- **CI diagnostics**: add temporary root-cause instrumentation for Nix store corruption flakes (`#272`)
  - `validateNixStoreStep` now captures full verify/repair/devenv logs and runner fingerprint into a diagnostics directory
  - Failed jobs now add a compact diagnostics summary and upload a diagnostics artifact for triage
  - Added a temporary `workflow_dispatch` debug switch to force a controlled CI failure and verify diagnostics summary/artifact behavior end-to-end
  - Marked as temporary with explicit cleanup intent once root cause is identified and CI is stable
- **devenv/tasks/shared/ts.nix**: Fix `ts:emit` missing `--build` flag
  - `tscWithDiagnostics` was called without `--build`, causing tsc to treat `tsconfig.all.json` as a source file
  - Previously masked by `setup:opt:*` wrappers silently swallowing the failure
- **beads packaging**: Avoid long emulated builds by using patched prebuilt `bd` release binaries (v0.55.4)
  - `nix/beads.nix` now fetches release tarballs instead of compiling Go sources under QEMU
  - Linux binaries are patched with Nix loader/RPATH (`icu74`) so Dolt-enabled `bd` runs correctly
- **@overeng/genie**: `genie --check` now fails fast on fatal `.genie.ts` import/build errors and marks interrupted sibling checks as canceled
  - Prevents indefinite stalls when a sibling check remains in-flight after a fatal import/build failure
  - Final JSON/TUI failure state is reconciled from `GenieGenerationFailedError.files` to avoid stale `active` entries
- **beads packaging/tasks**: Fix `bd` Dolt startup failures on macOS by building with CGO enabled and updating beads task/hook invocations for current CLI flags
  - `nix/beads.nix` now builds `bd` from source (`buildGo126Module`) with CGO + ICU/SQLite inputs instead of prebuilt no-CGO release tarballs
  - `nix/devenv-modules/tasks/shared/beads.nix` now uses Dolt-directory bootstrap checks and removes deprecated `--no-daemon/--no-db` flag usage

### Changed

- **genie/ci-workflow**: Switch CI helpers to lock-pinned `DEVENV_BIN` instead of PATH `devenv`
  - Replaced `installDevenvFromLockStep` with `preparePinnedDevenvStep` and made task commands use `"$DEVENV_BIN"`
  - `validateNixStoreStep` now runs `devenv info` with `restrict-eval = false` appended in `NIX_CONFIG`
  - `runDevenvTasksBefore` now forwards that unrestricted `NIX_CONFIG` to all `devenv tasks run ...` calls
  - `standardCIEnv` now defaults `NIX_CONFIG` to `restrict-eval = false` for CI jobs, and validation/tasks use that shared default

- **@overeng/megarepo**: Scope nested `megarepo.lock` reconciliation to recursive sync mode
  - `mr sync` now syncs direct member lock artifacts only (`flake.lock` / `devenv.lock`)
  - Nested `megarepo.lock` reconciliation now runs only with `mr sync --all`

- **devenv/tasks/shared/megarepo.nix**: Make `megarepo:sync` always run with `--frozen`
  - Prevents shell-entry and routine task runs from rewriting `megarepo.lock`
  - Adds `megarepo:sync:update` for intentional non-frozen lockfile updates

- **devenv/dt**: Remove CI/non-interactive TUI suppression workaround now that devenv auto-disables TUI in CI
  - Dropped manual `DEVENV_TUI=false` handling and PTY stderr piping from `dt`
  - Updated failure re-run hints to use `devenv tasks run ... --mode before` without `--no-tui`

- **@overeng/genie**: Reduce duplicate check-time work by reusing loaded genie modules between content verification and validation
  - Added `loadGenieFile` / `checkFileDetailed` in core generation to return reusable module/context metadata
  - `checkAll` now passes preloaded modules into `runGenieValidation` instead of re-importing every `.genie.ts`
  - Switched formatting hot path to in-process `oxfmt` API with CLI fallback, eliminating per-file formatter process spawn in normal operation

- **devenv/otel-span**: Consolidate `otel-span` and `otel-emit-span` into single CLI with subcommands
  - `otel-span run <service> <span-name> [opts] -- <cmd>` replaces bare `otel-span <service> ...`
  - `otel-span emit` replaces `otel-emit-span` (reads OTLP JSON from stdin)
  - Breaking: subcommand is now required

- **devenv/otel.nix**: Hard-cut system-mode dashboard sync compatibility
  - `OTEL_MODE=system` now fails shell entry when `OTEL_STATE_DIR`, `OTEL_EXPORTER_OTLP_ENDPOINT`, or `otel` CLI is missing
  - Removed `OTEL_DASHBOARDS_DIR` shell env export
  - Removed shell-side `extraDashboards` merge logic; `extraDashboards` is now rejected in system mode

- **devenv/otel.nix**: Replace `curl` with file spool (`otlpjsonfilereceiver`) in `otel-span`
  - Spans are written to `$OTEL_SPAN_SPOOL_DIR/spans.jsonl` instead of HTTP POST
  - Collector picks up spans via `otlpjsonfilereceiver` (500ms poll, delete after read)
  - Falls back to `curl` if spool dir not available
  - Reduces per-span overhead from ~58ms to <1ms

### Fixed

- **devenv/otel-span**: Emit boolean attributes and manage task trace context
  - `--attr` now serializes `true`/`false` values as `boolValue` (aligns dashboard TraceQL filters)
  - `otel-span` reads `OTEL_TASK_TRACEPARENT` (preferred over `TRACEPARENT`) and exports both for child processes
  - This isolates task traces from stale shell `TRACEPARENT` values caused by devenv shell re-evaluations

- **devenv/dt**: Simplify trace context propagation
  - `dt` now clears `TRACEPARENT` and delegates context management entirely to `otel-span`
  - Removes manual trace/span ID generation that was previously duplicated between `dt.nix` and `otel-span`

- **devenv/otel-span**: Add `--status-attr KEY` flag for status check spans
  - Derives bool attribute from exit code (0=true, non-zero=false)
  - Forces span status to OK (status checks aren't errors, exit 1 means "not cached")
  - Used by `trace.status` to set `task.cached` without masking the real exit code

- **devenv/tasks/lib/trace.nix**: Trace status checks with method and sub-trace support
  - `trace.status` now accepts a `method` parameter (`"binary"`, `"hash"`, `"path"`)
  - Status body runs INSIDE `otel-span` (not post-hoc) so sub-programs inherit TRACEPARENT
  - Binary status checks (e.g. `genie --check`, `mr status`) now produce child spans
  - `task.cached` is derived from exit code via `--status-attr` (no explicit bool passing)
  - Each real status execution gets its own span (no deduplication — duplicate spans from devenv's
    shell re-evaluations accurately reflect what actually happened)

- **devenv/tasks/shared/lint-oxc.nix**: Wire up `genieCoverageExcludes` and add `genieCoverageFiles` (#198)
  - `genieCoverageExcludes` was accepted but never applied; now uses git pathspec exclusion
  - New `genieCoverageFiles` parameter (default: `["package.json" "tsconfig.json"]`) makes checked file types configurable
  - Removed dead `defaultExcludes`/`excludeArgs` code from obsolete `find`-based approach
  - Made doc examples more generic (removed `@overeng`-specific paths)

### Added

- **genie**: Add programmatic TS SDK (`@overeng/genie/sdk`) for calling genie's generate/check
  logic from TypeScript without the CLI. Core orchestration extracted into shared `core.ts` using
  PubSub + Stream event bus pattern, consumed by both CLI (TUI progress) and SDK (silent).

- **genie**: Split `src/build/` into `src/core/` (shared, no TUI deps), `src/build/` (CLI/TUI),
  and `src/sdk/` (programmatic API). Each export path now maps 1:1 to a directory. SDK consumers
  no longer need `jsx` in their tsconfig.

- **devenv/tasks/shared/worktree-guard.nix**: Git hook to enforce worktree workflow
  - Refuses commits on the default branch (detected via `refs/remotes/<remote>/HEAD` with fallback)
  - Optionally refuses commits from the primary worktree
  - Detects megarepo store worktrees and prevents commits when the path-implied ref doesn't match `HEAD`

- **devenv/tasks/shared/ts.nix**: Add `ts:emit` task (`tsc --build --noCheck`) and use it for shell entry
  - Keeps `ts:build` as the typechecked build
  - Improves shell entry performance by skipping full type checking during emit
  - Shell entry now runs `ts:patch-lsp` separately; `ts:emit` no longer depends on patching so it can be used standalone
- **devenv/otel.nix**: TRACEPARENT propagation for shell entry waterfall tracing
  - `setup:gate` generates root TRACEPARENT for shell entry traces
  - `setup:save-hash` emits a `devenv:shell:entry` root span
  - `trace.nix` generates fallback TRACEPARENT when not already set
  - Enables end-to-end waterfall view in Grafana Tempo for shell startup

- **devenv.nix**: Nix eval visibility and cold-start detection
  - `SHELL_ENTRY_TIME_NS` captured at enterShell start
  - `shell:ready` marker span with `cold_start` attribute
  - `dt.nix` adds `shell.ready_ms` attribute for eval+setup time tracking

- **devenv/otel.nix**: `otel:test` task for shell-level unit tests
  - Validates JSON format, TRACEPARENT propagation, spool write, and fallback
  - Runs offline (~2s) without requiring `devenv up`

- **@overeng/otel-cli**: Spool file verification in `otel debug test`
  - Tests both HTTP and file spool delivery paths end-to-end
  - Gracefully skips spool test when `OTEL_SPAN_SPOOL_DIR` not set

- **@overeng/genie**: Validate `pnpmWorkspaceYaml` rejects absolute paths in `packages` during `genie:check` (#152)

- **@overeng/otel-cli**: New Effect CLI package for OTEL stack diagnostics and trace exploration
  - `otel health` — per-component health status (Grafana, Tempo, Collector)
  - `otel trace ls` — tabular trace listing with TraceQL query filtering
  - `otel trace inspect` — span tree with ASCII waterfall visualization
  - `otel metrics ls/query/tags` — TraceQL metrics querying with sparkline rendering
  - `otel api` — raw HTTP calls to Grafana, Tempo, Collector APIs
  - `otel debug test/dashboards` — E2E smoke tests and dashboard inspection

- **devenv/otel.nix**: Full OTEL observability stack as reusable devenv module
  - OTEL Collector + Grafana Tempo + Grafana with hash-based deterministic port allocation
  - Auto-provisioned dashboards via Grafonnet (Jsonnet DSL) build pipeline
  - `otel-span` shell helper for wrapping commands in OTLP trace spans
  - Compatible with Effect OTEL layers (same env var/protocol)

- **devenv/tasks/lib/trace.nix**: Task tracing helper with cache status tracking
  - `trace.exec` wraps task exec scripts with `otel-span` for child span emission
  - `trace.status` emits spans with `task.cached=true` for cached tasks
  - Applied to all shared task modules (ts, genie, lint, pnpm, test, megarepo, etc.)

- **devenv/otel/dashboards**: 6 Grafonnet dashboards with manual grid positioning
  - Overview, dt Task Performance, Shell Entry, pnpm Install Deep-Dive, TS App Traces, dt Duration Trends
  - dt-tasks dashboard with cache status filtering (executed vs cached)

- **@overeng/utils**: `node/otel` module for Effect-native OTEL instrumentation in CLI apps
  - `makeOtelCliLayer()` wires OTLP exporter with W3C TRACEPARENT propagation from `dt` tasks
  - Zero overhead when `OTEL_EXPORTER_OTLP_ENDPOINT` is not set

- **devenv**: Netlify deploy tasks for storybook preview deployments
  - New shared `netlify.nix` task module with `netlify:deploy:<name>` per-package tasks
  - Supports prod, PR preview (alias), and local draft deploy modes via `--input` flags
  - CI job `deploy-storybooks` deploys all 7 storybooks on PRs and pushes to main
  - Replaces Vercel-based storybook deployments

- **@overeng/tui-react**: Standalone `run` function with dual (data-first/data-last) API (#129)
  - `run(app, handler, { view })` replaces `Effect.scoped(Effect.gen(function* () { const tui = yield* app.run(view); ... }))`
  - Scope managed internally — consumers no longer need `Effect.scoped`
  - Error type `E` inferred from handler (no explicit error schema needed)
  - Added `TuiAppTypeId` brand and `isTuiApp` predicate for runtime type detection

### Fixed

- **devenv/lint**: Simplify `lint:check:format` by reverting to direct `oxfmt --check` invocation (#157)
  - Removed `git ls-files` complexity — oxfmt's directory walker already excludes `node_modules`
  - Added `pnpm:install` dependency to ensure stable `node_modules` state during formatting
  - Investigation confirmed `experimentalSortImports` uses string-based classification (no filesystem reads)

- **@effect/language-service/TypeScript config**: Elevate `missedPipeableOpportunity` diagnostics to warnings
  - `missedPipeableOpportunity` now emits as `warning` so Effect LSP findings are visible in non-IDE CLI typechecks
  - Keeps `ts:check` in `--noEmit` mode while preserving the existing `ts:check`/`ts:build` behavior split (#218)

- **CI/storybook**: Fix storybook builds used by Netlify preview deploys
  - Stub `@opentui/*` in `@overeng/genie` Storybook build (OpenTUI requires Bun runtime)
  - Fix `@overeng/tui-react` examples importing `src/mod.ts` (actual entry is `src/mod.tsx`)

- **CI/deploy-storybooks**: Make Netlify preview deploys more reliable
  - Run the deploy job on `ubuntu-latest` (avoids flaky Namespace runner Nix store state)
  - `netlify:deploy:*` now depends on `storybook:build:*` so deploys always have build output

- **@overeng/tui-react**: Fix `OutputCauseSchema` using `Schema.Never` for error field (#129)
  - Changed `error: Schema.Never` to `error: Schema.Defect` in `OutputCauseSchema`
  - Previously, typed errors (e.g. `GenieGenerationFailedError`) caused `ParseError: Expected never` during JSON encoding, masking the real error

### Changed

- **devenv/tasks**: Optimized `check:quick` by prioritizing utils package install
  - Moved utils and utils-dev to front of install queue for earlier `ts:patch-lsp` start
  - `check:quick` improved from ~18-28s to ~14-15s through better task parallelism

- **devenv/ts.nix**: Per-project tsc tracing via `--extendedDiagnostics` parsing
  - When OTEL is available, `ts:check` and `ts:build` emit per-project child spans with timing attributes
  - ~3% overhead when active, zero overhead when OTEL unavailable
  - Renamed `ts:watch` to `ts:build-watch`

- **@overeng/tui-react**, **@overeng/megarepo**, **@overeng/notion-cli**, **@overeng/genie**: Migrated all consumers to standalone `run` API (#129)
  - All command files now use `run(App, handler, { view })` instead of manual `Effect.scoped` + `app.run()`
  - Updated test utilities (`runTestCommand`) to not require `Scope.Scope`

- **@overeng/tui-react**: Automatic log capture for progressive-visual modes (breaking change)
  - `outputModeLayer()` now captures all Effect logs and `console.*` output in tty/ci/alt-screen modes
  - Captured logs accessible via `useCapturedLogs()` hook in React components
  - Prevents accidental log output from corrupting TUI terminal rendering
  - Console methods (`log`, `error`, `warn`, `info`, `debug`) are scoped and restored on cleanup
  - New `LogCapture.ts` module with `createLogCapture()`, `CapturedLogsProvider`, `useCapturedLogs()`
  - New example `06-log-capture/` demonstrating the feature
  - Updated spec.md with log capture documentation

- **@overeng/utils-dev**: New package with enhanced Vitest utilities for Effect-based testing
  - `makeWithTestCtx` / `withTestCtx` for automatic layer provisioning, OTEL integration, and timeouts
  - `asProp` for property-based testing with shrinking phase visibility
  - Migrated 22 test files across 7 packages to the new pattern

- **@overeng/genie**: GitHub Repository Ruleset generator (`githubRuleset`)
  - Type-safe configuration for GitHub Repository Rulesets via the REST API
  - Full support for all 22 rule types with comprehensive JSDoc documentation
  - Generates JSON config applied via `gh api repos/{owner}/{repo}/rulesets`
  - Added ruleset configuration for effect-utils protecting the main branch

### Changed

- **devenv/ts.nix**: Centralized Effect Language Service patching via `ts:patch-lsp` task
  - Removed per-package `postinstall: 'effect-language-service patch'` scripts from all 15 packages
  - Added `lspPatchCmd` parameter to `ts.nix` that creates a `ts:patch-lsp` task
  - Fixes consumer install failures for published packages (e.g. `@overeng/react-inspector`)
- Effect LSP patching now runs automatically before `ts:check`, `ts:build-watch`, `ts:build`

- **devenv/ts.nix**: Use package-local patched tsc binary for Effect Language Service diagnostics
  - Added `tscBin` parameter (default: `"tsc"`) to specify a patched TypeScript binary
  - Nix-provided tsc is unpatched and silently skips Effect plugin diagnostics
  - `ts:clean` uses Nix tsc (always available, doesn't need the patch)

- **@overeng/megarepo**, **@overeng/tui-react**: Migrated tests from async/await to `@effect/vitest`
  - All Effect-based tests now use `it.effect()` pattern instead of `async () => { await Effect.runPromise(...) }`
  - Provides better stack traces, fiber-aware timeouts, and cleaner Effect integration
  - See [#92](https://github.com/overengineeringstudio/effect-utils/issues/92)

- **@overeng/megarepo**: Simplified nix integration - removed workspace generator
  - Removed `mr generate nix` command and `.envrc.generated.megarepo` file
  - Removed `.direnv/megarepo-nix/workspace` mirror directory
  - Removed `MEGAREPO_ROOT_*`, `MEGAREPO_MEMBERS`, `MEGAREPO_NIX_WORKSPACE` env vars
  - Use `DEVENV_ROOT` (provided by devenv) instead of `MEGAREPO_ROOT_NEAREST`
  - Simplified `.envrc` to just `use devenv` (no generated file needed)

- **@overeng/megarepo**: Split `pnpmDepsHash` by platform to fix Linux/Darwin store divergence

- **@overeng/megarepo**: Nix lock sync is now auto-detected and uses top-level config
  - **Breaking**: Moved from `generators.nix.lockSync` to top-level `lockSync` config
  - Lock sync is now **auto-detected**: enabled if `devenv.lock` or `flake.lock` exists in megarepo root
  - No configuration needed for the common case; set `lockSync.enabled: false` to opt-out
  - Removed vestigial `NixGeneratorConfig` and `generators.nix` config options

- **nix/devenv-modules/tasks/shared/megarepo.nix**: Simplified megarepo tasks
  - Removed `megarepo:generate` task (no longer needed)
  - Simplified `megarepo:check` to just verify repos/ directory exists
  - Tasks no longer check for `.envrc.generated.megarepo` or workspace flake

### Fixed

- **@overeng/megarepo**: Configure fetch refspec when cloning bare repos (#111)
  - `git clone --bare` doesn't set `remote.origin.fetch`, breaking `git push --force-with-lease`
  - Now `cloneBare` configures `+refs/heads/*:refs/remotes/origin/*` after clone
  - Ensures remote tracking refs are created on fetch for proper git workflows

- **@overeng/tui-react**: Strengthen JSON schema typing in `TuiApp` unit tests
  - Replaced generic JSON parsing and `any` casts with schema-encoded helpers

- **@overeng/genie**: Fix YAML serializer producing empty output with matrix strategy
  - When GitHub Actions workflows use `${{ }}` expressions inside inline arrays (e.g., `runs-on: [${{ matrix.runner }}]`), oxfmt fails to parse the YAML
  - The `formatWithOxfmt` function now returns original content when oxfmt produces empty output
  - Closes [#108](https://github.com/overengineeringstudio/effect-utils/issues/108)

- **nix/devenv-modules/tasks/shared/test.nix**: Self-contained test tasks - each package uses its own vitest
  - Previously test tasks shared a vitest binary from `@overeng/utils`, violating self-contained packages requirements (R1-R5)
  - Now each package runs tests using `node_modules/.bin/vitest` from its own dependencies
  - Added `vitest.config.ts` to packages that were missing one: effect-path, effect-rpc-tanstack, genie, notion-cli, notion-effect-client, notion-effect-schema
  - Removed deprecated `vitestBin`, `vitestConfig`, and `vitestInstallTask` parameters from test module
  - This ensures packages are independently testable without cross-package dependencies

- **nix/devenv-modules/tasks/shared/nix-cli.nix**: Preflight lockfile/package.json fingerprint checks in `nix:check`
  - Prevents warmed Nix stores from masking stale hashes
  - Makes `nix:check` deterministic in CI vs local runs (R5)

- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Deterministic pnpm store tarball creation
  - Normalizes tar output (stable ordering + fixed timestamps)
  - Strips non-deterministic pnpm store `checkedAt` metadata
  - Prevents pnpm deps hash churn across CI runs
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Force `supportedArchitectures` in Nix pnpm installs
  - Ensures pnpm store hashes remain stable across macOS/Linux (R5)
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Generate pnpm store with recursive install
  - Aligns store generation scope with offline install (R6)
  - Prevents missing tarballs during `nix:check` for multi-package workspaces
- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Force dev dependencies during pnpm store generation
  - Avoids production-only installs that drop dev-only tarballs
  - Fixes `ERR_PNPM_NO_OFFLINE_TARBALL` in `nix build`/`nix:check`

### Removed

- **@overeng/mono**: Removed package entirely — all functionality is now covered by devenv tasks (`dt`). The package had zero consumers across all repos.

### Infrastructure

- **pnpm workspaces**: Hoist React-family packages in React-enabled workspaces to prevent duplicate React instances during local dev

- **nix/workspace-tools/lib/mk-pnpm-cli.nix**: Added `packageJsonDepsHash` parameter to fix build failures
  - `build.nix` files were passing `packageJsonDepsHash` but the function didn't accept it
  - Fixes `nix flake check` failures and downstream repo devenv shell issues
  - Renamed from `depsHash` to `packageJsonDepsHash` for clarity (breaking change)

- **nix/workspace-tools/lib/mk-bun-cli.nix**: Added `lockfileHash` and `packageJsonDepsHash` parameters for consistency
  - Both CLI builders now support the same fingerprint hash interface
  - Enables `nix:check:quick` to work uniformly across both build types

- **nix/devenv-modules/tasks/shared/nix-cli.nix**: Fixed missing task dependencies and improved error messages
  - `nix:check:*` tasks now depend on `pnpm:install` (full workspace)
  - Previously only depended on per-package install, causing failures when other packages had stale lockfiles
  - Added clear error messages for stale lockfiles with actionable fix instructions
  - Detects `ERR_PNPM_OUTDATED_LOCKFILE` and suggests `dt pnpm:update && dt nix:hash`

- **nix/devenv-modules/tasks/shared/pnpm.nix**: Added `pnpm:update` task
  - Runs `pnpm install --no-frozen-lockfile` in all packages to update lockfiles
  - Use when adding new dependencies that cause `ERR_PNPM_OUTDATED_LOCKFILE` errors
  - Now depends on `genie:run` so generated package.json files are up to date

- **nix/devenv-modules/tasks/shared/pnpm.nix**: Renamed `pnpm:clean-lock-files` to `pnpm:reset-lock-files`
  - Makes it clear this is a destructive, last-resort operation

- **nix/devenv-modules/tasks/shared/check.nix**: Updated check task semantics
  - `check:quick` - Fast development checks (genie, typecheck, lint, nix-fingerprint only)
  - `check:all` - Comprehensive validation including full `nix flake check`
  - `check:packages` - New task to validate allPackages matches filesystem

- **nix/devenv-modules/tasks/local/workspace-check.nix**: New local validation task
  - Validates that `allPackages` in devenv.nix matches actual filesystem packages
  - Prevents Nix build failures from unmanaged packages with stale lockfiles
  - Located in `local/` directory (effect-utils specific, not for reuse)

- **nix/devenv-modules/tasks**: Reorganized into `shared/` and `local/` directories
  - `shared/` - Reusable tasks meant for other repos via flake input
  - `local/` - Effect-utils specific tasks (not exported in flake.nix)
  - Added README.md documenting the organization

- **nix/devenv-modules/tasks/shared/check.nix**: Added `extraChecks` parameter
  - Allows repos to inject additional check tasks (e.g., `workspace:check`)
  - Maintains reusability while enabling local customization

- **devenv.nix**: Updated taskModules to use `shared/` directory paths
  - Fixed regression where local paths weren't updated after directory restructure

- **devenv.nix**: Added missing `packages/@overeng/tui-react` to `allPackages`

### Fixed

- **genie/internal**: Ensure `pnpmWorkspaceYaml` is locally imported so `pnpmWorkspaceReact` does not throw a ReferenceError

### Added

- **@overeng/effect-rpc-tanstack**: New package for Effect RPC integration with TanStack Start
  - `createRpcHandler` - Create server function handlers from Effect handlers
  - `createRpcHandlerWithLayer` - Handler with Effect Layer dependency injection
  - `wrapHandler` - Wrap handlers for proper error handling
  - `rpcValidator` - Schema validator for TanStack Start server functions
  - `RpcRequest/RpcResponse/RpcSuccess/RpcFailure/RpcDefect` - Protocol types
  - `RpcDefectError` - Client-side error type for unexpected server errors
  - Basic example with TanStack Start app and Playwright tests

### Changed

- **@overeng/utils**: Updated `effect-distributed-lock` to 0.0.11 and patched root exports to avoid loading optional `ioredis` (see https://github.com/ethanniser/effect-distributed-lock/issues/10)

- **@overeng/notion-effect-cli**: Migrated config from JSON to TypeScript (breaking change)
  - Config file is now `notion-schema-gen.config.ts` instead of `.notion-schema-gen.json`
  - Databases are now keyed by their Notion ID instead of an array
  - New `defineConfig` helper with full type checking and autocompletion
  - New typed `transforms` helpers (e.g., `transforms.status.asString`) instead of string literals
  - New `outputDir` option for base output directory (paths are relative to it)
  - Import config helpers from `@overeng/notion-effect-cli/config`
  - CLI now requires Bun runtime for native TypeScript config loading

- **@overeng/notion-effect-cli**: Adopted type-safe file paths from `@overeng/effect-path` (breaking change)
  - `DatabaseConfig.output` now requires `RelativeFilePath` - use `file()` helper
  - `SchemaGenConfig.outputDir` now requires `RelativeDirPath` - use `dir()` helper
  - Import `file` and `dir` helpers from `@overeng/notion-effect-cli/config`
  - Internal path operations now use `EffectPath.ops.*` instead of `node:path`
  - Removed `Path.Path` service dependency from Effect requirements

- **Monorepo CLI**: Replaced Biome with oxc toolchain (oxlint + oxfmt)
  - Removed `@biomejs/biome` dependency
  - `mono lint` now uses oxlint exclusively
  - `mono fmt [--check]` - Format code with oxfmt (Prettier-compatible, 30× faster)
  - `mono check` now includes format verification
  - Added shared oxlint/oxfmt configuration via `@overeng/oxc-config` package

- **@overeng/oxc-config**: New package for shared oxlint + oxfmt configuration
  - Base config with sensible defaults for TypeScript/Effect projects
  - Rules: `import/no-dynamic-require` (warn), `oxc/no-barrel-file` (warn, except `mod.ts`), `overeng/named-args` (warn), `import/no-commonjs` (error), `import/no-cycle` (warn), `func-style` (warn, prefer expressions/arrows)
  - Re-exports only allowed from `mod.ts` entry point files
  - Custom `overeng/named-args` rule enforces named arguments pattern (options objects), with automatic exemptions for callbacks, rest params, and Effect patterns

### Added

- **@overeng/utils**: Force revoke / lock stealing for file-system semaphore backing
  - `forceRevoke(options, key, holderId)` - Forcibly revoke a specific holder's permits
  - `forceRevokeAll(options, key)` - Revoke all holders for a semaphore key
  - `listHolders(options, key)` - List active holders with permit counts and expiry times
  - `HolderInfo` type for holder information
  - `HolderNotFoundError` for when target holder doesn't exist
  - See upstream feature request: https://github.com/ethanniser/effect-distributed-lock/issues/9

- **@overeng/notion-effect-schema**: New `PropertySchema` discriminated union for typed database property definitions
  - Full support for all 23 Notion property types using `Schema.TaggedStruct`
  - `SelectOptionConfig`, `StatusGroupConfig` for select/multi-select/status options
  - `NumberFormat`, `RollupFunction` enums
  - All property schemas exported individually (e.g., `SelectPropertySchema`, `RelationPropertySchema`)

- **@overeng/notion-effect-client**: New `SchemaHelpers` module for database schema introspection
  - `getProperties({ schema })` - Get all properties as typed `PropertySchema[]`
  - `getProperty({ schema, name })` - Get single property by name
  - `getPropertyByTag({ schema, name, tag })` - Get property filtered by type
  - `getSelectOptions({ schema, property })` - Get select property options
  - `getMultiSelectOptions({ schema, property })` - Get multi-select options
  - `getStatusOptions({ schema, property })` - Get status options
  - `getAnySelectOptions({ schema, property })` - Get options from any select-like property
  - `getRelationTarget({ schema, property })` - Get relation target database info
  - `getFormulaExpression({ schema, property })` - Get formula expression
  - `getNumberFormat({ schema, property })` - Get number format
  - `getRollupConfig({ schema, property })` - Get rollup configuration
  - `getUniqueIdPrefix({ schema, property })` - Get unique ID prefix

### Changed

- **@overeng/notion-effect-schema**: Renamed `Database` to `DatabaseSchema` for clarity (breaking change)
  - The type represents the schema/structure of a database, not the data itself

- **@overeng/notion-effect-cli**: Refactored introspect.ts to use new typed `PropertySchema` from schema package
  - Removed manual property type definitions in favor of shared schemas

- **@overeng/notion-effect-cli**: Generated schemas now include Effect Schema annotations
  - Schemas include `identifier` and `description` annotations for better debugging/tooling
  - Property fields with descriptions now have JSDoc comments instead of inline comments
  - Typed options (when `--typed-options` is used) also include `identifier` annotations

- Renamed **@overeng/notion-effect-schema-gen** to **@overeng/notion-effect-cli** to support more general-purpose CLI functionality
  - Binary name changed from `notion-effect-schema-gen` to `notion-effect-cli`
  - All commands remain the same: `generate`, `introspect`, `generate-config`, `diff`

### Added

- **@overeng/utils**: Workspace helpers (`CurrentWorkingDirectory`, `EffectUtilsWorkspace`) and command utilities (`cmd`, `cmdText`) with optional log capture/retention
- **Monorepo CLI**: Added `mono` CLI for streamlined development workflow
  - `mono build` - Build all packages
  - `mono test [--unit|--integration] [--watch]` - Run tests with filtering options
  - `mono lint [--fix]` - Check formatting and run oxlint
  - `mono ts [--watch] [--clean]` - TypeScript type checking
  - `mono clean` - Remove build artifacts
  - `mono check` - Run all checks (ts + fmt + lint + test)
  - Available directly in PATH via `scripts/bin/mono` wrapper
  - VSCode tasks.json for easy command palette integration
  - CI-aware output with GitHub Actions log grouping

- **@overeng/notion-effect-client**: Block helpers and Markdown converter improvements
  - `BlockHelpers` namespace with typed utilities for custom transformers:
    - `getRichText(block)` - Extract rich text content
    - `getCaption(block)` - Get media block captions
    - `getUrl(block)` - Get URL from image/video/file/embed/bookmark blocks
    - `isTodoChecked(block)` - Check to-do status
    - `getCodeLanguage(block)` - Get code block language
    - `getCalloutIcon(block)` - Get callout emoji
    - `getChildPageTitle(block)` / `getChildDatabaseTitle(block)` - Get titles
    - `getTableRowCells(block)` - Get table row cells
    - `getEquationExpression(block)` - Get equation expression
  - `BlockWithData` type for blocks with type-specific data
  - All helpers also exported as standalone functions
  - Rich Text utilities: `toPlainText`, `toMarkdown`, `toHtml` via `RichTextUtils`
  - Recursive block fetching: `NotionBlocks.retrieveAllNested` (flat stream), `NotionBlocks.retrieveAsTree` (tree)
  - Markdown converter: `NotionMarkdown.pageToMarkdown`, `NotionMarkdown.treeToMarkdown`, `NotionMarkdown.blocksToMarkdown`
  - Custom transformer support for all 27 block types

- **@overeng/react-inspector**: Added as git submodule for Effect Schema-aware data inspection
  - DevTools-style object/table/DOM inspectors for React
  - Enriched display of Effect Schema types with type names and custom formatting
  - Runs on port 9001 (separate from effect-schema-form-aria Storybook on 6006)
  - Maintains its own tooling (tsup, ESLint) - excluded from monorepo biome config

### Documentation

- **@overeng/notion-effect-cli**: Added comprehensive README with usage examples for CLI and programmatic API

### Added

- **@overeng/notion-effect-cli**: `diff` command for detecting schema drift
  - Compares current Notion database schema against an existing generated TypeScript file
  - Reports added properties (new in Notion), removed properties (no longer in Notion), and type changes
  - `--file` / `-f`: Path to existing generated schema file (required)
  - `--exit-code`: Exit with code 1 if differences found (useful for CI)
  - Parses generated schema files to extract property definitions
  - Displays formatted diff output with summary

- **@overeng/notion-effect-client**: Schema-aware typed queries and page retrieval
  - `TypedPage<T>` interface combining page metadata with decoded properties
  - `PageDecodeError` for schema decoding failures
  - `NotionDatabases.query()`: Now accepts optional `schema` parameter for typed results
  - `NotionDatabases.queryStream()`: Now accepts optional `schema` parameter for typed streaming
  - `NotionPages.retrieve()`: Now accepts optional `schema` parameter for typed retrieval
  - All methods return `TypedPage<T>` when schema is provided, with `id`, `createdTime`, `url`, `properties`, and `_raw` access

- **@overeng/notion-effect-cli**: Database API wrapper generation
  - `--include-api` / `-a` flag: Generate typed database API wrapper alongside schema
  - Generated API file includes:
    - `query()`: Stream-based query with auto-pagination
    - `queryAll()`: Collect all results
    - `get()`: Retrieve single page by ID
    - `create()`: Create page (when `--include-write` enabled)
    - `update()`: Update page (when `--include-write` enabled)
    - `archive()`: Archive page
  - Config file support: `includeApi` option in database and defaults config
  - API file written to `{output}.api.ts` (e.g., `tasks.ts` → `tasks.api.ts`)

### Fixed

- **@overeng/notion-effect-schema**: Fixed `BlockSchema` to preserve type-specific properties
  - Block objects now correctly retain their type-specific data (e.g., `block.paragraph`, `block.heading_1`)
  - Previously, decoding would strip these properties, breaking markdown conversion and block helpers
- **@overeng/notion-effect-client**: Removed yieldable-error `Effect.fail` usage and simplified search result literal schema
- **@overeng/notion-effect-cli**: Replaced global `Error` failures with tagged config/token errors

- **@overeng/notion-effect-cli**: Critical fixes to generated schema code
  - Fixed import references to use correct transform namespaces (e.g., `Title`, `Select`, `Num` instead of `TitleProperty`, `SelectProperty`, `NumberProperty`)
  - Fixed write schema generation to use nested Write APIs (e.g., `Title.Write.fromString` instead of `TitleWriteFromString`)
  - Generated schemas now correctly work with `@overeng/notion-effect-schema` package
  - Added integration tests verifying generated schemas decode/encode properly with actual Notion API data structures
  - Added runtime validation helpers to generated code:
    - Read helpers: `decode{Name}Properties`, `decode{Name}PropertiesEffect`
    - Write helpers: `decode{Name}Write`, `decode{Name}WriteEffect`, `encode{Name}Write`, `encode{Name}WriteEffect`

### Changed

- Renamed all packages from `@schickling` scope to `@overeng` scope
- TypeScript builds now emit ESM JavaScript to `dist/` with source maps and declaration maps.
- Property "read" transforms are now decode-only; write payloads are modeled separately via `*Write` schemas / transforms.
- Notion HTTP client retry behavior:
  - Treats request-body JSON encoding failures as typed `NotionApiError` (instead of defects).
  - Respects `retry-after` on 429 responses when retrying.
- Updated dependencies to latest versions (effect ^3.19.13, @effect/platform ^0.94.0)
- Moved all dependencies to pnpm catalog for centralized version management
- Updated pnpm catalog versions (Effect 3.19.14, @effect/platform 0.94.1, TypeScript 5.9.3, Vite 7.3.0, Vitest 3.2.4, Tailwind 4.1.18) and added @effect/rpc for peer compatibility

### Added

- **@overeng/effect-react**: React integration for Effect runtime
  - `makeReactAppLayer` for layer-based app initialization with React
  - `useServiceContext` hook for accessing Effect services from React components
  - `LoadingState` context for tracking app initialization progress
  - `ServiceContext` utilities for running effects with a provided runtime
  - React hooks: `useAsyncEffectUnsafe`, `useInterval`, `useStateRefWithReactiveInput`
  - `cuid` and `slug` utilities for generating unique IDs

- **@overeng/effect-schema-form**: Headless form component for Effect Schemas
  - Schema introspection utilities (`analyzeSchema`, `getStructProperties`, `analyzeTaggedStruct`)
  - Field type detection: string, number, boolean, literal, struct, unknown
  - Context + hooks API pattern for custom rendering
  - `SchemaFormProvider` for design system integration
  - `useSchemaForm` hook for building custom form UIs
  - Support for optional fields, tagged structs, and literal unions
  - `formatLiteralLabel` utility for human-readable label formatting

- **@overeng/effect-schema-form-aria**: Styled React Aria implementation
  - Pre-configured `AriaSchemaForm` component with accessible UI
  - `ariaRenderers` object for use with `SchemaFormProvider`
  - Individual styled components: `TextField`, `NumberField`, `BooleanField`, `LiteralField`
  - `FieldGroup` and `FieldWrapper` layout components
  - Tailwind CSS styling with design token support
  - Automatic segmented control/select switching for literal fields

- **@overeng/notion-effect-cli**: Full CLI implementation for schema generation
  - `generate` subcommand: Introspects a Notion database and generates Effect schemas
    - `--output` / `-o`: Output file path for generated schema
    - `--name` / `-n`: Custom name for the generated schema (defaults to database title)
    - `--token` / `-t`: Notion API token (defaults to NOTION_API_TOKEN env var)
    - `--transform`: Per-property transform configuration (e.g., `Status=raw`)
    - `--dry-run` / `-d`: Preview generated code without writing to file
    - `--include-write` / `-w`: Include Write schemas for creating/updating pages
    - `--typed-options`: Generate typed literal unions for select/status options
  - `introspect` subcommand: Displays database schema information
  - `generate-config` subcommand: Generates schemas for all databases from config
  - Config file support (`.notion-schema-gen.json`) for multi-database projects
  - Configurable property transforms per type (raw, asString, asOption, asNumber, etc.)
  - Support for all 21 Notion property types with sensible defaults
  - Improved PascalCase handling that preserves existing casing
  - Auto-formatting with Biome when available
  - Uses Effect FileSystem and Path for file operations
  - Generated code includes proper Effect Schema imports and type exports
  - Deterministic code generation (no timestamps); header includes generator version
  - Comprehensive unit tests for code generation functionality

- **@overeng/notion-effect-schema**: Core Notion object schemas
  - `Database`, `Page`, `Block` with full field definitions
  - Parent types: `DatabaseParent`, `PageParent`, `BlockParent`
  - File objects: `ExternalFile`, `NotionFile`, `FileObject`
  - Icon types: `EmojiIcon`, `CustomEmojiIcon`, `Icon`
  - Block type enum covering all 27 Notion block types
  - `DataSource` for database data sources

- **@overeng/notion-effect-schema**: Comprehensive Effect schemas
  - Foundation schemas: `NotionUUID`, `ISO8601DateTime`, `NotionColor`, `SelectColor`
  - Rich text support: `RichText`, `TextAnnotations`, `MentionRichText`, `EquationRichText`
  - User schemas: `Person`, `Bot`, `PartialUser`, `User` union
  - Property schemas with:
    - decode transforms (e.g. `Title.asString`, `Num.asNumber`, `Select.asStringRequired`)
    - write payload schemas/transforms for page create/update (e.g. `TitleWrite`, `SelectWrite`, `PeopleWrite`)
  - Custom `docsPath` annotation linking each schema to official Notion API docs
  - Proper Effect `Option` handling for nullable/optional fields

- **@overeng/notion-effect-client**: Comprehensive test suite with real API integration
  - Unit tests for internal HTTP utilities
    - `parseRateLimitHeaders`, `buildRequest`, `get`, `post` functions
    - `NotionApiError.isRetryable` logic
    - Pagination utilities: `paginationParams`, `toPaginatedResult`, `paginatedStream`
  - Integration tests for service modules (skipped when no token)
    - Databases: `retrieve`, `query`, `queryStream` with filters and pagination
    - Pages: `retrieve`, `create`, `update`, `archive`
    - Blocks: `retrieve`, `retrieveChildren`, `retrieveChildrenStream`, `append`, `update`, `delete`
    - Users: `me`, `list`, `listStream`, `retrieve`
    - Search: `search`, `searchStream` with filters and sorting
  - `describe.skipIf` pattern for graceful skipping when no API token
  - Separate `test:unit` and `test:integration` npm scripts

## [0.1.0] - 2025-08-03

Initial release of effect-notion monorepo.

### Added

- **@overeng/notion-effect-schema**: Effect schemas for the Notion HTTP API
- **@overeng/notion-effect-client**: Effect-native HTTP client for the Notion API
- **@overeng/notion-effect-cli**: CLI tool for schema generation

### Infrastructure

- Initial monorepo setup with pnpm workspaces
- TypeScript configuration with project references
- Modern ESM-first package structure
