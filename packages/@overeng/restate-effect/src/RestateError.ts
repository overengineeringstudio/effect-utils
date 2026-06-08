import { Schema } from 'effect'

/**
 * Single tagged error for `@overeng/restate-effect` wrapper-level failures.
 *
 * This is the error channel for the *wrapper's* own bridge operations
 * (durable `ctx.run`/`ctx.sleep`, serde, endpoint lifecycle, registration,
 * ingress) — NOT the user's domain errors. Domain `Schema.TaggedError`s flow
 * through the handler's own `E` channel and are mapped to a Restate
 * `TerminalError` at the endpoint boundary (see `Endpoint.toTerminal`).
 *
 * Mirrors `@overeng/pty-effect`'s `PtyError`:
 * - `reason` discriminator for programmatic matching
 * - `cause: Schema.Defect` for the upstream error (preserves name + message)
 * - custom `get message()` for clean human-readable output in logs/traces
 *
 * Reasons:
 * - `RunFailed`          — a durable `ctx.run` step rejected
 * - `SleepFailed`        — a durable `ctx.sleep` rejected
 * - `SerdeFailed`        — encode/decode at the serde boundary failed
 * - `EndpointFailed`     — the HTTP/2 endpoint server failed to bind/serve
 * - `RegistrationFailed` — deployment registration with the admin API failed
 * - `IngressFailed`      — an external ingress client call failed
 */
export class RestateError extends Schema.TaggedError<RestateError>(
  '@overeng/restate-effect/RestateError',
)('RestateError', {
  reason: Schema.Literal(
    'RunFailed',
    'SleepFailed',
    'SerdeFailed',
    'EndpointFailed',
    'RegistrationFailed',
    'IngressFailed',
  ),
  method: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {
  override get message(): string {
    const parts: string[] = [this.reason, `(${this.method})`]
    if (this.cause instanceof Error) parts.push(`: ${this.cause.message}`)
    else if (this.cause !== undefined) parts.push(`: ${String(this.cause)}`)
    return parts.join(' ')
  }
}
