# Restate owns durable retries; Effect Schedule is for pure logic only

Durable retries are Restate's responsibility. The binding never wraps durable
operations in `Effect.retry` / `Effect.repeat` (that would re-run them
non-durably and risk double-retry + nondeterminism). Instead it surfaces
Restate's retry controls as typed options: a `retryPolicy` on service/handler
builders (`maxAttempts`, initial/max interval, `exponentiationFactor`,
`onMaxAttempts: pause | kill`), `RunOptions` on the `run` combinator, and
`RetryableError` / `Restate.retryable(effect, { retryAfter })` as the explicit
retryable signal. `Effect.retry` / `Schedule` remain available for pure,
non-durable computation only (lint/doc enforced).

## Why

- Consistent with "Restate is the engine" — Restate's journal-preserving
  retry/backoff is a core feature; re-implementing it in Effect-land
  double-retries and breaks replay determinism.

Status: accepted
