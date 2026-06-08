# Vision: restate-effect

`@overeng/restate-effect` is a fully Effect-idiomatic, type-safe binding to
[Restate](https://restate.dev)'s durable-execution engine. It exposes Restate's
own model — Services, Virtual Objects, Workflows, and the durable context
primitives — as Effect-returning combinators, layering Effect idioms (Schema
I/O, tagged errors, Layers and Scopes, OpenTelemetry) on top without hiding
Restate.

## The Problem

### Problem 1: Restate's strengths are foreign to Effect codebases

Restate solves durable execution — journaling, deterministic replay,
virtual-object state, exactly-once side effects — as a single Rust binary in
front of plain handlers. But its TypeScript SDK is built around bare
`async (ctx, input) => Promise<output>` handlers, untyped JSON I/O by default,
thrown-error retry semantics, and a single untyped context. An Effect codebase
that wants Restate's durability has to drop out of Effect at every handler
boundary, lose Schema typing, and re-learn an imperative idiom that fights the
rest of the system.

### Problem 2: The untyped boundary erases the contract

The SDK's handler I/O is JSON-by-default and its inter-service / ingress clients
are phantom-typed: a caller hand-declares the handler shape to get any typing at
all. Input validation, output shape, the set of business failures a handler can
return, and the wire encoding are all conventions rather than enforced
contracts. Mistakes surface at runtime, across the wire, far from the call site.

### Problem 3: Determinism is correct-if-the-author-remembers

Restate's replay contract requires every source of nondeterminism — wall-clock
reads, randomness, UUIDs, external I/O — to be funneled through the context so
its result is journaled once and replayed thereafter. A raw `Date.now()`,
`Math.random()`, or un-journaled fetch in a handler is a latent replay bug
(server error `RT0016`) that the type system does nothing to prevent. Effect's
own defaults (`Clock`, `Random`, the fiber scheduler) read real time and PRNG
and silently break replay.

### Problem 4: Error and retry concerns smear through every signature

Restate distinguishes terminal errors (no retry, propagate to caller, trigger
compensation) from everything else (retry). Without a disciplined boundary, the
distinction leaks into every handler: infrastructure failures, retry hints, and
genuine business failures all travel the same channel, and a handler's type
signature stops meaning anything precise about what can go wrong.

### Problem 5: Observability is two disconnected halves

Restate's server emits its own spans (`ingress_invoke`, `invoke`) and its SDK
OTel hook emits per-attempt spans; an Effect program emits its own spans through
a separate tracer. Left unbridged, a single invocation produces fragmented
traces, and naive in-handler telemetry double-counts on every replay. Proper
observability requires one coherent trace and exactly-once-on-replay emission —
neither of which falls out for free.

### Problem 6: Testing durable handlers is heavyweight

The SDK's first-party testing path is Docker/testcontainers-based: it spins a
Restate container per test environment. For an Effect codebase that already
expresses resources as scoped Layers, a Docker dependency is friction that
discourages writing the integration tests durable handlers most need.

## The Vision

- **Restate's model, spoken in Effect.** Every construct and durable primitive
  is exposed as an Effect-returning combinator with Restate's own vocabulary
  intact — a faithful binding, not a vendor-neutral facade over a pluggable
  engine. (Problem 1)
- **The contract is the type.** Handlers declare their input, success, and
  business-error Schemas once; from that single definition the binding derives
  validated I/O and fully typed ingress and in-handler clients, so the wire
  boundary feels like a local, typed, validated call. (Problem 2)
- **Illegal operations are unrepresentable.** Restate's context-capability rules
  (write state only in an exclusive handler; resolve a durable promise only in a
  workflow `run`) are encoded in the type system, so misuse is a compile error.
  (Problem 1, Problem 2)
- **Determinism is correct by construction.** Inside a handler, time, randomness,
  and sleep are backed by the journaled context, so idiomatic Effect time
  combinators become durable waits automatically; raw nondeterminism is caught
  by lint as a backstop. (Problem 3)
- **The error channel means one thing.** A handler's typed error channel carries
  only declared business failures, which cross the wire as terminal errors and
  decode back into the original tagged error on the caller side; infrastructure
  failures are defects that Restate retries. (Problem 4)
- **Restate owns durable retries.** Retry and backoff are surfaced as typed
  Restate controls, never re-implemented with Effect schedules that would
  re-run non-durably. (Problem 4)
- **One coherent trace, counted once.** A first-class OpenTelemetry bridge shares
  a single tracer provider with Restate's hook, parents Effect spans under the
  attempt span, and gates side-effecting telemetry on replay state. (Problem 5)
- **Testing is a Docker-free scoped Layer.** A native `restate-server` harness
  boots on ephemeral ports in an isolated base dir as a scoped Layer, so
  consumers integration-test their own durable handlers without containers.
  (Problem 6)

## What This Is Not

- **Not a vendor-neutral durable-execution abstraction.** It does not hide
  Restate behind a pluggable-engine facade, and it does not depend on or mirror
  `@effect/cluster` / `@effect/workflow` as the engine. Restate is the
  programming model and the engine. See
  [decisions/0001-thin-faithful-restate-binding.md](./decisions/0001-thin-faithful-restate-binding.md).
- **Not a second durable engine for Effect.** Those who want Effect's own durable
  engine use `@effect/workflow` + `@effect/cluster`; this binding is for those
  who have chosen Restate.
- **Not a re-implementation of Restate's runtime.** It owns no journal, no state
  store, no retry loop; the `restate-server` owns all of that.
- **Not engine-portable.** Handler code is coupled to Restate's model by design;
  the coupling buys mechanical sympathy with the engine.

## Success Criteria

1. A handler is authored as an Effect with Schema-typed input, success, and
   business errors, and runs durably against a real `restate-server` without the
   author writing any bridge code.
2. Writing state in a read-only handler, or resolving a durable promise outside a
   workflow `run`, fails to typecheck.
3. A typed ingress or in-handler client is inferred from a contract alone (no
   hand-declared handler shape), validates its arguments, returns the typed
   success, and surfaces typed business errors that the caller matches with
   `catchTag`.
4. Idiomatic Effect time combinators (`Effect.sleep`, `Effect.timeout`) inside a
   handler become Restate-durable timers, and a raw `Date.now()` / `Math.random()`
   in a handler body is flagged by lint.
5. A single invocation — external caller through ingress, invoke, attempt, and
   in-handler Effect spans — forms one coherent OpenTelemetry trace, with custom
   span events and metric increments emitted exactly once across replays.
6. A consumer integration-tests its own durable handlers against a native
   `restate-server` provided as a scoped Layer, with no Docker dependency, and
   tests run parallel-safe on ephemeral ports.
