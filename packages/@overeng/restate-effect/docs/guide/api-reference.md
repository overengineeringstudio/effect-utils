# API reference

[← Handbook index](./README.md)

The public surface, by subpath. The authoritative list is
[`src/mod.ts`](../../src/mod.ts) / [`src/otel.ts`](../../src/otel.ts) /
[`src/testing.ts`](../../src/testing.ts).

## `.` (core)

| Symbol | What |
| --- | --- |
| `RestateService.{contract, implement, define}` | author a stateless Service |
| `RestateObject.{contract, implement}` | author a keyed Virtual Object (typed State, exclusive/shared) |
| `RestateWorkflow.{contract, implement}` | author a Workflow (one `run`, signals, queries) |
| `State.for(schemas)` | typed, capability-gated State combinators (`get`/`set`/`clear`/`clearAll`/`stateKeys`) |
| `DurablePromise.for(schema)` | typed durable-promise combinators (`get`/`peek`/`resolve`/`reject`/`getDescriptor`) |
| `Awakeable.{make, resolve, reject}` | typed external-completion tokens |
| `Restate.{run, runExit, sleep, timeout, all, race, any}` | durable steps, timers, and deterministic concurrency |
| `Restate.{runDescriptor, sleepDescriptor, callDescriptor, objectCallDescriptor}` | descriptors for `all`/`race`/`any`/`timeout` |
| `Restate.{call, send, objectClient, objectSendClient, workflowClient, workflowSubmit}` | in-handler service-to-service clients |
| `Restate.reschedule({ contract, method, input, delayMillis })` | typed durable self-send (re-arm a keyed handler after a delay) |
| `RestateScheduled.make(config)` / `Restate.pollLoop` | a narrow durable recurring-loop Virtual Object (`fixedDelay`, `start`/`stop`/`status`) |
| `RestateScheduled.{Schedule, OnCycleError}` | the loop's schedule (`fixedDelay`) + error-policy (`skipToNext`/`stopLoop`) builders |
| `Restate.key` | the current Object/Workflow invocation key (`ObjectKey`) |
| `Restate.{cancel, onCancellation}` | cancel another invocation; observe this one's cancellation |
| `Restate.annotateSpan(attrs)` | stamp custom business span attributes (the user observability path) |
| `Restate.{terminal, retryable, serde, idempotencyKey, retention, sensitive, redacted}` | Schema annotations |
| `layer(opts)` / `serve(opts)` | the scoped endpoint Layer / long-lived entrypoint |
| `materialize` / `materializeObject` / `materializeWorkflow` / `materializeAny` | lower-level boundary wiring (the endpoint builds on these) |
| `toTerminal` / `classifyOutcome` | the error-boundary mapping + the single outcome classifier |
| `RestateIngress` + `call`/`callTyped`/`objectCall`/`objectCallTyped`/`objectSend`/`workflowSubmit`/`workflowAttach`/`workflowOutput`/`workflowCall`/`result`/`ingressResolveAwakeable`/`ingressRejectAwakeable` | the typed external ingress client |
| `decodeTerminalError` / `decodeErrorWith` | re-decode a terminal body into the tagged error |
| `RestateError` | the wrapper's own tagged failure (`reason` discriminator) |
| `RestateRedaction` / `aesGcmRedactionLayer` / `aesGcmCipher` / `RedactionCipherMissingError` | field-level redaction cipher |
| `effectSerde` / `ingressSerde` / `internalSerde` | the Schema ↔ Restate `Serde` bridge |
| `determinismLayer` / `withAttemptInterruption` | the per-invocation runtime boundary helpers (wired by `materialize*`; exported for direct testing) |
| `RestateContext`, `StateRead`, `StateWrite`, `ObjectKey` | capability-marker Tags (appear in handler `R`) |
| `invocationsTotal` / `invocationDurationMs` / `attemptsTotal` / `durableStepsTotal` / `awakeableWaitMs` / `pollLoopCyclesTotal` | the baseline Effect `Metric` definitions (re-exported for inspection) |

The exported types include the contract/implementation shapes
(`Contract`/`HandlerSpec`/`ServiceImpl`/…), the indexed accessors
(`InputOf`/`SuccessOf`/`ErrorOf`/`MethodsOf` and their Object/Workflow variants),
the durable-op types (`Descriptor`/`DurableCaps`/`ResultsOf`/`RunRetryOptions`/
`SendOptions`/`StateSchemas`/`StateValueType`/`AwakeableId`), and the endpoint types
(`EndpointOptions`/`EndpointHooks`/`HandlerWrap`/`BoundaryObserver`/…). See
[`src/mod.ts`](../../src/mod.ts) for the full list.

## `./otel`

| Symbol | What |
| --- | --- |
| `RestateOtel.layer(config)` | the shared `TracerProvider` + (opt-in) `MeterProvider` Layer |
| `RestateOtel.withOtel(endpointOptions)` | attach hook + inbound bridge + boundary observer to every handler |
| `RestateOtel.hook` / `inboundBridge` | the per-service / per-invocation TRACE seams (compose by hand) |
| `RestateOtel.boundaryObserver` | the per-invocation span-attribute stamper (identity + error class) |
| `restate_*` metric definitions | the auto baseline Effect `Metric`s (re-exported for inspection) |
| `isReplaying` | replay-state flag (version-fragile; prefer `Restate.run`) |

`Restate.annotateSpan(attrs)` (on the core `Restate` namespace) is the user
span-attribute path.

## `./testing`

| Symbol | What |
| --- | --- |
| `RestateTestHarness.layer(opts)` | the scoped native-server harness Layer |
| `RestateTestHarness` | the harness service (`ingress`, `stateOf`, `ingressUrl`, `adminUrl`) |
| `withRestateServer(opts)` | manual-scope harness holder (`setup`/`teardown`/`harness()`) |
| `makeTestContext` / `makeTestContextLayer` | the FAITHFUL in-memory `RestateContext` for server-free handler-logic tests |
| `liveSleep` / `withLiveClock` | live-clock test utils (real-time waits under `it.effect`'s `TestClock`) |
| `serverAvailable` | whether a native `restate-server` binary is on `$PATH` |
| `StateProxy` / `BoundIngress` | the typed `stateOf` proxy / pre-bound ingress surface types |
| `TestContextOptions` / `TestHandlerKind` / `HeldRestateServer` | the in-memory-context + holder option/result types |

## See also

Each symbol is covered in context by the topic page it belongs to — start from the
[handbook index](./README.md).
