# Verification + migration notes

[← Handbook index](./README.md)

## How the examples are verified

The [`examples/`](../../examples) directory holds runnable `.ts` files (covered by
the package `tsconfig` and `dt ts:check`).
[`src/examples.integration.test.ts`](../../src/examples.integration.test.ts) imports
the example contracts/impls and drives them through the [`./testing`](./testing.md)
harness against a real native `restate-server`, and
[`src/scheduled.integration.test.ts`](../../src/scheduled.integration.test.ts) does
the same for the self-reschedule example. So `dt check:all` both type-checks every
snippet and runs the documented behavior end-to-end.

A doc example that does not compile or run is treated as a **defect**. Every code
block in this handbook is drawn from one of these verified files:

| Topic                            | Example file                                                                                  | Verified by                        |
| -------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------- |
| Service + typed error boundary   | [`01-service.ts`](../../examples/01-service.ts)                                               | `examples.integration.test.ts`     |
| Virtual Object + typed State     | [`02-virtual-object.ts`](../../examples/02-virtual-object.ts)                                 | `examples.integration.test.ts`     |
| Workflow + durable promise       | [`03-workflow.ts`](../../examples/03-workflow.ts)                                             | `examples.integration.test.ts`     |
| Endpoint (`layer` / `serve`)     | [`04-endpoint.ts`](../../examples/04-endpoint.ts)                                             | `ts:check`                         |
| Determinism + descriptors        | [`05-determinism.ts`](../../examples/05-determinism.ts)                                       | `ts:check`                         |
| Typed ingress client             | [`06-ingress-client.ts`](../../examples/06-ingress-client.ts)                                 | `examples.integration.test.ts`     |
| Calls / idempotency / awakeables | [`07-clients-idempotency-awakeables.ts`](../../examples/07-clients-idempotency-awakeables.ts) | `examples.integration.test.ts`     |
| Annotations + redaction          | [`08-annotations.ts`](../../examples/08-annotations.ts)                                       | `ts:check`                         |
| OTel bridge                      | [`09-otel.ts`](../../examples/09-otel.ts)                                                     | `ts:check`                         |
| Cancellation                     | [`10-cancellation.ts`](../../examples/10-cancellation.ts)                                     | `cancellation.integration.test.ts` |
| Testing harness                  | [`11-testing.ts`](../../examples/11-testing.ts)                                               | `examples.integration.test.ts`     |
| Self-reschedule                  | [`12-self-reschedule.ts`](../../examples/12-self-reschedule.ts)                               | `scheduled.integration.test.ts`    |

The integration suite gracefully **skips** when no native `restate-server` binary is
on `$PATH` (`serverAvailable`), so the unit/contract layers stay runnable anywhere;
only the integration job needs the server.

## What is stable vs deferred

The stable v1 surface — Services, Virtual Objects, Workflows, the Schema serde +
typed error boundary, determinism, durable steps/calls/awakeables, cancellation, the
endpoint, `./otel`, and `./testing` (both the native-server harness and the
in-memory test context) — is implemented and verified end-to-end against a real
native `restate-server`.

Deferred (designed to slot in without reshaping the core):

- **Serverless targets** — Lambda / fetch / Cloudflare Workers endpoints. v1 is
  node-h2c only.
- **First-class saga helper** — a `withCompensation` combinator over the
  cancel↔interrupt mechanism (expressible by hand today; see
  [Cancellation](./cancellation.md#sagas-and-compensation)).
- **Scheduling / cron sugar** — `fixedRate` / `cron` schedules and the composed
  `retryAfter` + awakeable-wake loop (the [scheduling](./scheduling.md) page's stub).
- **`JournalValueCodec`** — an experimental whole-value byte layer (compression /
  whole-value encryption). **Field** redaction is NOT part of this — it is a serde
  Schema transform that ships in v1 (see [Annotations](./annotations.md#field-level-redaction)).
- **Admin / management wrappers** — typed wrappers over the admin API
  (registration, invocation cancel/kill/pause/resume, attach).

## Migration notes

- **From the POC `RestateService.make`.** The original proof-of-concept combined
  contract + implementation in one `make` call. That was superseded by the separated
  `contract` + `implement` (with `define` as the single-package convenience). See
  [decision 0010](../vrs/decisions/0010-separated-contract-impl.md). If you have
  `make`-shaped code, split it into `contract` (the shareable artifact) +
  `implement` (the server Layer), or use `define` to keep both in one expression.
- **From hand-rolled `ctx.run` plumbing.** Replace raw `ctx.run` / `ctx.sleep` calls
  with `Restate.run` / `Restate.sleep` so you get the clean `E`, the journaled
  Clock/Random, and the durability lints. Move any side effect or raw nondeterminism
  inside a `Restate.run` closure.
- **From `Effect.retry` around durable ops.** Remove it — durable retries are
  Restate's. Use the contract/handler `retryPolicy` options or `Restate.run`'s
  per-step `options` instead (see [Annotations](./annotations.md#retry-and-timeout-knobs)).
- **From `Effect.raceFirst` over an awakeable.** Use the awakeable `descriptor` with
  `Restate.race` instead — the in-process race loses journal-order determinism (see
  [Durable steps](./durable-steps.md#awakeables-and-other-durable-ops-in-a-deterministic-race)).

## See also

- [`spec.md`](../vrs/spec.md) — the full design model.
- [`decisions/`](../vrs/decisions/) — the hard-to-reverse design decisions.
- [Testing](./testing.md) — the test layering that gates CI.
