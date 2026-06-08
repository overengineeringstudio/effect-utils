# Error boundary: domain-only typed channel, terminal transport, infra-as-defect

The handler's Effect `E` channel carries ONLY declared domain (terminal) errors —
a `Schema.TaggedError` union the handler opts into via its `error` schema. The
boundary maps:

- Effect success → output serde → return value.
- Effect failure whose value matches the declared `error` schema →
  `restate.TerminalError`. The error is Schema-encoded into the `message` body
  (see below), with a PER-ERROR `errorCode` derived from the error's
  `terminal`/`retryable` annotation (default `500`; see
  [0011](./0011-restate-schema-annotations.md)). No retry; propagates to caller.
- A `retryable`-annotated domain error (or explicit `Restate.retryable(...)`,
  optional `retryAfter`) → non-terminal throw → Restate retries.
- Effect defect (incl. durable-combinator infrastructure failures, which are
  `orDie` by default) → rethrown → Restate retries, unless a service/handler
  `asTerminalError`-style policy classifies it terminal.

`TerminalError(message: string, options)` has no separate body channel — the
encoded error and its `_tag` travel in the `message` BODY (a JSON string), NOT
in `metadata`. The ingress `HttpCallError` exposes only `status` +
`responseText`, so anything placed in `metadata` is invisible to ingress
callers. The R14 decode helper therefore `JSON.parse`s the `responseText` (the
message body) and re-decodes through the error serde. `metadata._tag` is
best-effort EXTRA for in-handler / server-side consumers and needs server ≥1.6;
it is never the load-bearing channel.

Serde failures are SLOT-AWARE. A `ParseError` from `effectSerde.deserialize` on
INGRESS INPUT is a deterministic bad request → `TerminalError(400)` (retrying
cannot help). A decode failure on an INTERNAL slot (a State value, a `ctx.run`
result, an awakeable / durable-promise payload) is a CORRUPT-JOURNAL
infrastructure condition → DEFECT / retry (R13), NOT a 400 — the data was
written by a previous attempt or another handler, so a 400 to the current caller
would be wrong. The serde distinguishes these via a slot tag (or two entry
points), not a single "one serde, one 400" rule.

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
- Per-error `errorCode` lets callers distinguish 404/409/etc. instead of
  collapsing every domain failure to 500.

## Consequences

- Durable-combinator failures (`run`/`sleep`/state) are defects by default;
  observing them for compensation is opt-in.
- Typed cross-wire transport requires both sides to share the error Schema (fine
  within a codebase; cross-language callers get the encoded JSON body + `_tag`).

Status: accepted

_Revised after design review: per-error `errorCode` (from the error annotation,
not hardcoded 500); the encoded error + `_tag` travel in the message BODY (not
`metadata`, which ingress cannot see); slot-aware serde (ingress input → 400,
internal-slot corruption → defect/retry)._
