import { Schema } from 'effect'

/**
 * Single tagged error union for all `@overeng/pty-effect` failures.
 *
 * Schema-based so it round-trips cleanly through workers and serialization
 * boundaries (e.g. `@effect/platform` workers).
 *
 * Reasons:
 * - `SpawnFailed`     — failed to start a child pty process
 * - `ConnectFailed`   — failed to attach to a server-mode session
 * - `WriteFailed`     — write/press/type failed (socket closed, etc.)
 * - `ResizeFailed`    — resize was rejected by the backend
 * - `Timeout`         — a `waitFor*` schedule expired before the predicate matched
 * - `UnexpectedExit`  — the child process exited while we were waiting on it
 * - `BadName`         — session name failed validation
 * - `Closed`          — operation attempted after `close()`
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
    description: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect),
  },
) {}
