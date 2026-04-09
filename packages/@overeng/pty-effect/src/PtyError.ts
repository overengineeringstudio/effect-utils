import { Schema } from 'effect'

/**
 * Single tagged error for all `@overeng/pty-effect` failures.
 *
 * Follows `@effect/platform` conventions (`SystemError`, `HttpClientError`):
 * - `reason` discriminator for programmatic matching
 * - `cause: Schema.Defect` for the upstream error (preserves name + message
 *   through serialization)
 * - Custom `get message()` for clean human-readable output in logs/traces
 *
 * Reasons:
 * - `SpawnFailed`     — failed to start a child pty process or daemon
 * - `ConnectFailed`   — failed to attach to a server/daemon session
 * - `WriteFailed`     — write/press/type failed (socket closed, etc.)
 * - `ResizeFailed`    — resize was rejected by the backend
 * - `Timeout`         — a `waitFor*` schedule expired before the predicate matched
 * - `UnexpectedExit`  — the child process exited while we were waiting on it
 * - `BadName`         — session name failed validation
 * - `Closed`          — operation attempted after connection closed
 */
export class PtyError extends Schema.TaggedError<PtyError>('@overeng/pty-effect/PtyError')(
  'PtyError',
  {
    reason: Schema.Literal(
      'SpawnFailed',
      'ConnectFailed',
      'WriteFailed',
      'ResizeFailed',
      'Timeout',
      'UnexpectedExit',
      'BadName',
      'Closed',
    ),
    method: Schema.String,
    name: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {
  get message(): string {
    const parts = [this.reason]
    if (this.name !== undefined) parts.push(`[${this.name}]`)
    parts.push(`(${this.method})`)
    if (this.cause instanceof Error) parts.push(`: ${this.cause.message}`)
    else if (this.cause !== undefined) parts.push(`: ${String(this.cause)}`)
    return parts.join(' ')
  }
}
