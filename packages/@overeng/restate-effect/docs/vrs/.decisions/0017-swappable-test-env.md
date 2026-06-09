# Swappable mock⟷real `RestateTestEnv` façade

`./testing` exports `RestateTestEnv`: ONE `Context.Tag` whose surface is the
CONTRACT-ADDRESSED invocation level (`invokeService(contract, method, input)` —
NEVER `impl.method(input)`), with TWO Layer impls satisfying the same Tag, so the
SAME test body runs on either backend:

- `RestateTestEnv.mock({ services, appLayer })` — in-process dispatch over per-key
  `Map`s and a shared awakeable registry, NO journal, NO server. Fast (ms).
- `RestateTestEnv.real({ services, appLayer, alwaysReplay?, disableRetries? })` — a
  thin wrapper over the native-server `RestateTestHarness` (decision 0009).

It is the swappable façade OVER the two existing primitives, which stay available
(additive, no deletion): `makeTestContextLayer` (decision 0013, the in-memory
handler-logic primitive) and `RestateTestHarness` (decision 0009, the native-server
primitive). `RestateTestEnv` composes over them at the harness's contract-addressed
level so a single body can be parametrized over `it.each(['mock', 'real'])`.

## The load-bearing decision: typed `E` on BOTH backends

`invoke*` carries `RestateError | ErrorOf` (the TYPED declared error in `E`) on
BOTH backends, so `catchTag(DomainError)` compiles AND recovers identically on the
mock and the real server. The mock recovers the typed `E` by round-tripping the
failure through the contract's `error` schema — the SAME decode an ingress caller
performs on a terminal body — so a green mock test and a green real test assert
through the identical channel.

This also fixed a real wart: the harness `BoundIngress` once exposed `objectCall`
(widened `E = RestateError`) + `objectCallTyped` (`RestateError | ErrorOf`), and a
test had to escape to the standalone `callTyped` because the bound shorthand lost
the precise typed-error union. The bound surface now mirrors each `Client`
function's GENERIC signature, so the typed form IS the default invoke and the
precise typed-error + success channels survive (the escape is gone).

## How the mock reuses the package's real building blocks

The mock is NOT a re-implementation of the semantics — it dispatches through the
real building blocks:

1. Capture `Runtime<AppR>` once from `appLayer`.
2. Per-key State: a `Map<\`${service}/${key}\`, Map<string, unknown>>`;
`stateOf(contract, key)` reads/writes the SAME inner map (object/workflow key
   isolation for free), through the contract's per-key serde.
3. A SHARED awakeable registry at ENV scope, so `resolveAwakeable` from "outside" a
   handler completes a suspended handler (honest — it's just a promise).
4. Dispatch: find the impl fn for `(contract, method)`, pick `handlerKind` from the
   spec, build the in-memory `ctx` over the per-key Map + shared registry, provide
   the SAME marker subset `materialize*` provides (the shared
   `Endpoint.provideHandlerCaps` helper — the single source of truth for the
   per-kind capability provision), run on the captured runtime under
   `determinismLayer`, then classify the exit via the EXISTING
   `classifyOutcome(cause, spec.error)`.

## Honest mock-vs-real matrix

The mock supports: handler logic, typed success+error, typed State + per-key
isolation, `Restate.run` journaled-once WITHIN an invoke, deterministic
date/rand/sleep, awakeable resolve/await.

The mock does NOT model (real-only): durability/replay/suspension,
exactly-once-across-attempts/retry, single-writer/concurrency, cross-invocation
calls/sends/reschedule/pollLoop, admin-cancel, idempotency-keyed result attach,
OTel attempt-span reparenting. Anything real-only is authored directly against
`.real` (or kept in the dedicated `*.integration.test.ts`); the `kind` field +
`it.effect.skipIf(kind === 'real' && !serverAvailable)` is the gate.

## Consequences

- `RestateTestEnv` is public `./testing` API and must stay stable. The mock's `E`
  channel must stay identical to what an ingress caller decodes on the real server
  (kept in lock-step via the shared `classifyOutcome` + the schema round-trip).
- `Endpoint.provideHandlerCaps` is the single source of truth for the per-kind
  marker subset, reused by the real boundary (`runEffectHandler`) and the mock
  dispatch — so the two cannot drift.
- The mock-vs-real matrix is documented (this decision + the guide's testing page),
  so a consumer never mistakes a green mock test for durability/replay coverage.

Status: accepted
