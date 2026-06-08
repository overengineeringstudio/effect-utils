# Error boundary: domain-only typed channel, terminal transport, infra-as-defect

The handler's Effect `E` channel carries ONLY declared domain (terminal) errors —
a `Schema.TaggedError` union the handler opts into via its `error` schema. The
boundary maps:

- Effect success → output serde → return value.
- Effect failure whose value matches the declared `error` schema →
  `restate.TerminalError` (errorCode + `_tag` in metadata + Schema-encoded body).
  No retry; propagates to caller.
- Explicit `RetryableError` / `Restate.retryable(...)` (optional `retryAfter`) →
  non-terminal throw → Restate retries.
- Effect defect (incl. durable-combinator infrastructure failures, which are
  `orDie` by default) → rethrown → Restate retries, unless a service/handler
  `asTerminalError`-style policy classifies it terminal.

The ingress client provides a typed decode helper that reverses the transport: it
re-`Schema.decode`s a `TerminalError` body back into the original tagged error,
so callers `catchTag` typed errors rather than handling a raw `HttpCallError`.

## Why

- Makes the typed `E` channel mean exactly one thing — "terminal business
  failure" — instead of smearing infrastructure/retry concerns through every
  handler signature (the POC's #1 pain).
- Preserves the typed error boundary end-to-end across the wire, a headline
  reason to build this on Effect Schema.
- Respects Restate's ownership of retries (transient = retry by default; terminal
  = explicit domain error). See the separate retry-ownership decision.

## Consequences

- Durable-combinator failures (`run`/`sleep`/state) are defects by default;
  observing them for compensation is opt-in.
- Typed cross-wire transport requires both sides to share the error Schema (fine
  within a codebase; cross-language callers get the encoded JSON body + `_tag`).

Status: accepted
