# Requirements: restate-effect

Testable constraints for `@overeng/restate-effect`. Builds on
[vision.md](./vision.md). Terms are defined in [glossary.md](./glossary.md);
rationale for the hard-to-reverse choices lives in
[decisions/](./decisions/) and is cross-referenced by ID.

## Context

- The binding wraps the Restate TypeScript SDK family (`@restatedev/restate-sdk`
  and siblings, v1.14.x) against a `restate-server` (v1.6.x). It is Effect-native
  (`effect` ^3.21), so all behavior is expressed as Effects, Schemas, Layers, and
  Scopes.
- The design is fixed by ten accepted decision records,
  [0001](./decisions/0001-thin-faithful-restate-binding.md)–[0010](./decisions/0010-separated-contract-impl.md);
  this document states the cross-cutting, testable constraints those decisions
  imply. Where a requirement traces to a decision, the decision is cited.

## Assumptions

- **A01 Restate is the engine:** The `restate-server` owns the Journal, State,
  timers, retries, and Replay. The binding implements no durable-execution
  runtime of its own. (See [decisions/0001](./decisions/0001-thin-faithful-restate-binding.md).)
- **A02 SDK boundary shape:** A Restate handler is `(ctx, input) => Promise<O>`,
  invoked by the SDK; the per-invocation `ctx` carries the Journal, State, and
  key. The Effect runtime boundary therefore sits inside each handler body, not
  above the server.
- **A03 Single serde seam:** A Restate `Serde<T>` governs every Restate-managed
  value of type `T` (handler I/O, State, `ctx.run` results, awakeable payloads,
  durable promises, ingress). Its `serialize`/`deserialize` are synchronous over
  `Uint8Array`.
- **A04 Determinism contract:** Replay requires the same sequence of `ctx.*`
  operations in the same order. Nondeterminism (time, randomness, I/O) is only
  safe when funneled through `ctx` so its result is journaled. A journal mismatch
  is server error `RT0016`.
- **A05 Error duality:** Restate retries every thrown error except
  `TerminalError` (no retry, propagate to caller, trigger compensation). A
  suspension is not a failure (`isSuspendedError`).
- **A06 Standard Schema availability:** Effect `Schema` exposes JSON encode/decode
  and JSON Schema generation, which is sufficient to build the serde and the
  discovery payload over a JSON wire.
- **A07 Native server binary:** A native `restate-server` binary is available on
  `$PATH` (packaged via `nix/restate.nix`) for the testing harness and CI,
  without Docker.
- **A08 node-h2c target:** v1 targets a long-lived Node HTTP/2-cleartext (h2c)
  endpoint. Serverless targets (Lambda, fetch, Cloudflare Workers) are out of
  scope for v1.
- **A09 OTel opt-in:** The OpenTelemetry bridge and its dependencies
  (`@effect/opentelemetry`, `@restatedev/restate-sdk-opentelemetry`) are an
  opt-in subpath; the core stays dependency-light.

## Acceptable Tradeoffs

- **T01 Restate coupling over engine portability:** Handler code is coupled to
  Restate's model and vocabulary; there is no engine portability. Mechanical
  sympathy with the engine is worth more than a vendor-neutral abstraction. (See
  [decisions/0001](./decisions/0001-thin-faithful-restate-binding.md).)
- **T02 Durable-sleep remap over a non-durable default:** Every in-handler
  `Effect.sleep` / `Effect.timeout` becomes a journaled durable timer. This is
  correct-by-default for workflow waits at the cost of overhead for tight
  internal sleeps; a non-durable escape hatch may be added only if validation
  shows it is needed. (See [decisions/0004](./decisions/0004-determinism-layer.md).)
- **T03 Contract/impl ceremony over client-bundle pollution:** A service is
  authored as a separate `contract` and `implement`, adding ceremony for a
  trivial single-package service, to keep client bundles free of server code and
  dependencies. (See [decisions/0010](./decisions/0010-separated-contract-impl.md).)
- **T04 Explicit concurrency combinators over raw fibers:** Concurrency over
  durable operations must use `Restate.all` / `race` / `any`, not raw
  `Effect.fork` / concurrent `Effect.all`, trading some Effect ergonomics for
  deterministic journal ordering. (See [decisions/0005](./decisions/0005-deterministic-concurrency.md).)
- **T05 Internal type machinery over an untyped surface:** Encoding the
  capability hierarchy and preserving typed handler maps requires non-trivial
  internal generics; the cost is contained inside the builders so the authoring
  and calling surfaces stay clean. (See
  [decisions/0002](./decisions/0002-typed-capability-contexts.md),
  [decisions/0008](./decisions/0008-typed-client-inference.md).)
- **T06 Shared error Schema for typed cross-wire transport:** Decoding a terminal
  error back into its tagged form requires both sides to share the error Schema
  (natural within a codebase); cross-language callers get the encoded JSON body
  plus the `_tag` only. (See [decisions/0003](./decisions/0003-error-boundary-model.md).)

## Requirements

### Must be a faithful Restate binding

- **R01 Restate-native surface:** The binding MUST expose Restate's own
  constructs and durable primitives — Services, Virtual Objects, Workflows,
  `ctx.run`, durable sleep, awakeables, durable promises, keyed State,
  service-to-service calls/sends — each as an Effect-returning combinator using
  Restate's vocabulary. (Vision; [decisions/0001](./decisions/0001-thin-faithful-restate-binding.md).)
- **R02 No competing engine dependency:** The binding MUST NOT depend on
  `@effect/cluster` or `@effect/workflow` as a durable engine, and MUST NOT
  introduce a pluggable-engine abstraction over Restate. (Vision.)
- **R03 Avoidable external dependencies:** The core MUST keep its dependency
  surface to the Restate SDK family and `effect`; OTel dependencies MUST be
  reachable only through the opt-in subpath. (A09.)

### Must enforce capability safety in types

- **R04 Capability-gated combinators:** A durable combinator that requires a
  context capability (e.g. writing State, resolving a durable promise) MUST carry
  that requirement in its Effect `R` channel such that invoking it where the
  capability is not provided is a type error. (Vision; [decisions/0002](./decisions/0002-typed-capability-contexts.md).)
- **R05 Capability provision per handler kind:** The per-invocation boundary MUST
  provide exactly the capability markers legal for the construct and handler kind
  (service / exclusive / shared / workflow `run` / workflow shared), so legal
  handlers compile and illegal operations do not. (A02; [decisions/0002](./decisions/0002-typed-capability-contexts.md).)
- **R06 Typed State access:** Virtual Object / Workflow State access MUST be
  key- and value-typed against a declared State schema, so reading or writing an
  unknown key or a wrong-typed value is a type error.

### Must preserve a typed I/O and client contract

- **R07 Schema-typed I/O:** A handler's input, success, and business-error types
  MUST be declared as Effect `Schema`s and enforced at the boundary: input is
  decoded before the handler runs and success is encoded after. (A03, A06; [decisions/0010](./decisions/0010-separated-contract-impl.md).)
- **R08 JSON wire + discovery:** The serde MUST emit `application/json` for the
  encoded wire shape and MUST surface the schema's JSON Schema for Restate
  discovery. (A03, A06.)
- **R09 Contract/implementation separation:** A service contract (handler names +
  I/O/error Schemas) MUST be expressible and importable independently of the
  implementation, with no server code or server-only dependencies. (T03; [decisions/0010](./decisions/0010-separated-contract-impl.md).)
- **R10 Inferred typed clients:** From a contract alone the binding MUST derive
  typed clients — an external ingress client and in-handler service-to-service
  clients — whose arguments are Schema-validated, whose result is the typed
  success, and which require no hand-declared handler shape. (Vision; [decisions/0008](./decisions/0008-typed-client-inference.md).)

### Must guarantee a typed error boundary

- **R11 Domain-only error channel:** A handler's Effect `E` channel MUST carry
  only declared business (terminal) errors. (Vision; [decisions/0003](./decisions/0003-error-boundary-model.md).)
- **R12 Terminal transport:** A handler failure whose value matches the declared
  error Schema MUST cross the boundary as a `TerminalError` (Schema-encoded body
  plus the error `_tag` as metadata) that does not retry and propagates to the
  caller. (A05; [decisions/0003](./decisions/0003-error-boundary-model.md).)
- **R13 Infra-as-defect:** An Effect defect, including a durable-combinator
  infrastructure failure, MUST propagate as a normal throw so Restate retries it,
  unless an explicit terminal-classification policy applies. (A05; [decisions/0003](./decisions/0003-error-boundary-model.md).)
- **R14 Typed ingress decode:** The ingress client MUST provide a decode helper
  that reverses the transport, re-decoding a terminal-error body into the
  original tagged error so callers match it with `catchTag` rather than handling
  a raw transport error. (T06; [decisions/0003](./decisions/0003-error-boundary-model.md).)
- **R15 Suspension is never terminal:** The boundary MUST NOT convert a Restate
  suspension into a terminal error. (A05; [decisions/0003](./decisions/0003-error-boundary-model.md).)
- **R16 Deterministic-input failure:** A malformed or schema-invalid input MUST
  fail as a non-retryable terminal error (HTTP 400), since retrying cannot help.
  (A03.)

### Must guarantee determinism

- **R17 Journaled time and randomness:** Inside a handler runtime, `Clock` MUST
  read journaled time (`ctx.date`) and `Random` MUST read journaled, seeded
  randomness (`ctx.rand`), so idiomatic Effect time/random reads are
  replay-safe. (A04; [decisions/0004](./decisions/0004-determinism-layer.md).)
- **R18 Durable sleep remap:** `Clock.sleep` inside a handler MUST be remapped to
  `ctx.sleep`, so `Effect.sleep` / `Effect.timeout` become durable timers.
  (A04, T02; [decisions/0004](./decisions/0004-determinism-layer.md).)
- **R19 Deterministic durable concurrency:** Concurrency over durable operations
  MUST go through `Restate.all` / `race` / `any` (preserving journal order);
  raw fiber concurrency over durable operations MUST be guarded/lint-flagged.
  Sequential durable operations and pure in-handler concurrency need no special
  handling. (A04, T04; [decisions/0005](./decisions/0005-deterministic-concurrency.md).)
- **R20 Nondeterminism lint:** A lint rule MUST flag raw nondeterminism in
  handler bodies (`Date.now()`, `new Date()`, `Math.random()`,
  `crypto.randomUUID()`, and un-journaled I/O outside `ctx.run`) as an advisory
  backstop to the determinism layer. (A04; [decisions/0004](./decisions/0004-determinism-layer.md).)

### Must let Restate own retries

- **R21 No durable Effect retries:** The binding MUST NOT wrap durable operations
  in `Effect.retry` / `Effect.repeat` / `Schedule`; durable retry MUST be
  expressed only through Restate's controls (`retryPolicy`, `RunOptions`,
  `RetryableError`). Effect `Schedule` remains available for pure, non-durable
  computation. (A01; [decisions/0006](./decisions/0006-restate-owns-retries.md).)
- **R22 Surfaced retry controls:** Restate's retry controls MUST be exposed as
  typed options — a `retryPolicy` on service/handler builders, `RunOptions` on
  the durable-step combinator, and an explicit retryable signal
  (`RetryableError` / `Restate.retryable`, with an optional `retryAfter`). (A05; [decisions/0006](./decisions/0006-restate-owns-retries.md).)

### Must produce coherent, replay-correct observability

- **R23 One coherent trace:** With the OTel bridge enabled, a single invocation
  MUST produce one connected trace from the external caller through
  `ingress_invoke`, `invoke`, the attempt span, and the in-handler Effect spans,
  by sharing a single `TracerProvider` and parenting Effect spans under the
  attempt span. (Vision; [decisions/0007](./decisions/0007-otel-bridge.md).)
- **R24 Exactly-once-on-replay emission:** Custom span events and metric
  increments MUST be emitted exactly once across replays; replay MUST NOT
  double-emit. The attempt and `ctx.run` spans are owned by Restate's hook and
  MUST NOT be re-emitted by the Effect layer. (A04; [decisions/0007](./decisions/0007-otel-bridge.md).)
- **R25 Replay signal exposed:** An `isReplaying` capability MUST be available to
  gate side-effecting telemetry (and to user code). ([decisions/0007](./decisions/0007-otel-bridge.md).)

### Must be testable without Docker

- **R26 Scoped-Layer harness:** The binding MUST export a testing harness (opt-in
  subpath) as a scoped `Layer` that boots a native `restate-server` (no Docker),
  registers the deployment, and exposes the typed ingress client and State
  inspection. (A07; [decisions/0009](./decisions/0009-effect-native-testing-harness.md).)
- **R27 Parallel-safe isolation:** The harness MUST use ephemeral ports and an
  isolated base dir per instance so tests run parallel-safe and leave no shared
  state. (A07; [decisions/0009](./decisions/0009-effect-native-testing-harness.md).)
- **R28 Dedicated CI integration job:** CI MUST run the integration tests as a
  dedicated job with `restate-server` on `$PATH` (from `nix/restate.nix`, with
  `allowUnfree` scoped to `restate`). (A07; [decisions/0009](./decisions/0009-effect-native-testing-harness.md).)

### Must shut down gracefully

- **R29 Endpoint as scoped Layer:** The endpoint MUST be a scoped `Layer` whose
  acquisition starts serving and whose finalizer closes the server, so that
  `serve` under `NodeRuntime.runMain` gives SIGTERM-driven graceful shutdown that
  finalizes the application Layer in the same scope. (A02, A08.)
- **R30 Per-invocation runtime boundary:** The shared application runtime MUST be
  built once from a Layer; the per-invocation `ctx` and its capability markers
  MUST be provided per call, never placed in the long-lived application Layer.
  (A02.)
