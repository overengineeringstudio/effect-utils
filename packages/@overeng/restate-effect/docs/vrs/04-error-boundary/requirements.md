# Requirements: 04-error-boundary

**Role.** The seam mapping an Effect outcome onto a Restate outcome: a
domain-only typed `E` channel that crosses the wire as a `TerminalError`,
infra-as-defect, slot-aware serde failure, typed ingress decode, cancellation ↔
interruption, and Restate-owned retry surfacing. Owns what "failure" means across
the binding.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). IDs are GLOBAL and preserved.

## Requirements

### Must guarantee a typed error boundary

- **R11 Domain-only error channel:** A handler's Effect `E` channel MUST carry
  only declared business (terminal) errors. (Vision; [../.decisions/0003](../.decisions/0003-error-boundary-model.md).)
- **R12 Terminal transport:** A handler failure whose value matches the declared
  error Schema MUST cross the boundary as a `TerminalError` whose `message` BODY
  is the Schema-encoded error plus its `_tag` (the `responseText` an ingress
  caller sees), with a per-error `errorCode` derived from the error's
  `terminal`/`retryable` annotation (default 500). The `_tag` MAY ALSO appear in
  `metadata` as a best-effort extra for server-side consumers (server ≥1.6, A10),
  but `metadata` is invisible to ingress callers so it is never the load-bearing
  channel. It does not retry and propagates to the caller. (A05; [../.decisions/0003](../.decisions/0003-error-boundary-model.md), [../.decisions/0011](../.decisions/0011-restate-schema-annotations.md).)
- **R13 Infra-as-defect:** An Effect defect, including a durable-combinator
  infrastructure failure, MUST propagate as a normal throw so Restate retries it,
  unless an explicit terminal-classification policy applies. (A05; [../.decisions/0003](../.decisions/0003-error-boundary-model.md).)
- **R14 Typed ingress decode:** The ingress client MUST provide a decode helper
  that reverses the transport, re-decoding a terminal-error body into the
  original tagged error so callers match it with `catchTag` rather than handling
  a raw transport error. (T06; [../.decisions/0003](../.decisions/0003-error-boundary-model.md).)
- **R15 Suspension is never terminal:** The boundary MUST NOT convert a Restate
  suspension into a terminal error. (A05; [../.decisions/0003](../.decisions/0003-error-boundary-model.md).)
- **R16 Slot-aware serde failure:** A serde `ParseError` MUST be classified by
  slot. A malformed or schema-invalid INGRESS INPUT MUST fail as a non-retryable
  terminal error (HTTP 400), since retrying cannot help. A decode failure on an
  INTERNAL slot (State value, `ctx.run` result, awakeable / durable-promise
  payload) is a corrupt-journal infrastructure condition and MUST propagate as a
  defect that Restate retries (R13), NOT a 400. (A03; [../.decisions/0003](../.decisions/0003-error-boundary-model.md).)

### Must let Restate own retries

- **R21 No durable Effect retries:** The binding MUST NOT wrap durable operations
  in `Effect.retry` / `Effect.repeat` / `Schedule`; durable retry MUST be
  expressed only through Restate's controls (`retryPolicy`, `RunOptions`,
  `RetryableError`). Effect `Schedule` remains available for pure, non-durable
  computation. (A01; [../.decisions/0006](../.decisions/0006-restate-owns-retries.md).)
- **R22 Surfaced retry controls:** Restate's retry controls MUST be exposed as
  typed options — a `retryPolicy` on service/handler builders, `RunOptions` on
  the durable-step combinator, and an explicit retryable signal
  (`RetryableError` / `Restate.retryable`, with an optional `retryAfter`). (A05; [../.decisions/0006](../.decisions/0006-restate-owns-retries.md).)

### Must surface cancellation as interruption

- **R31 Cancellation ↔ interruption:** A Restate cancellation MUST surface as an
  Effect INTERRUPTION at the next await point, so `onInterrupt` / `acquireRelease`
  finalizers and compensations run. An in-handler Effect interruption MUST NOT be
  terminalized or blindly retried (it is not a domain failure). The attempt's
  `Request.attemptCompletedSignal` (AbortSignal) MUST be bridged to
  attempt-scoped finalization, with the caveat that the same logical invocation
  may later get a new attempt. (A05; [../.decisions/0003](../.decisions/0003-error-boundary-model.md).)
