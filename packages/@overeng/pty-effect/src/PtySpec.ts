import { Schema } from 'effect'

/**
 * Pty session names per upstream's `validateName`: `[a-zA-Z0-9._-]{1,255}`.
 * Branded so misuse fails at the schema layer rather than inside upstream.
 */
export const PtyName = Schema.String.pipe(
  Schema.pattern(/^[a-zA-Z0-9._-]{1,255}$/),
  Schema.brand('@overeng/pty-effect/PtyName'),
)
export type PtyName = typeof PtyName.Type

/** Terminal dimensions. */
export const TerminalSize = Schema.Struct({
  rows: Schema.Number.pipe(Schema.int(), Schema.positive()),
  cols: Schema.Number.pipe(Schema.int(), Schema.positive()),
})
export type TerminalSize = typeof TerminalSize.Type

/**
 * Spec for `Session.spawn` mode — direct PTY backed by a child process.
 *
 * Use for testing CLIs and TUI apps where you don't need detach/reattach.
 */
export const PtySpawnSpec = Schema.Struct({
  _tag: Schema.tag('Spawn'),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String })),
  size: Schema.optional(TerminalSize),
})
export type PtySpawnSpec = typeof PtySpawnSpec.Type

/**
 * Spec for `Session.server` mode — persistent PtyServer with a Unix socket.
 *
 * Use for testing detach/reattach, multi-client, and resize negotiation.
 * `name` is auto-generated if omitted.
 */
export const PtyServerSpec = Schema.Struct({
  _tag: Schema.tag('Server'),
  command: Schema.String,
  args: Schema.optional(Schema.Array(Schema.String)),
  cwd: Schema.optional(Schema.String),
  size: Schema.optional(TerminalSize),
  name: Schema.optional(PtyName),
})
export type PtyServerSpec = typeof PtyServerSpec.Type

/** Tagged union of all spec variants. */
export const PtySpec = Schema.Union(PtySpawnSpec, PtyServerSpec)
export type PtySpec = typeof PtySpec.Type

/** Convenience constructors. */
export const PtySpec_ = {
  spawn: (input: Omit<PtySpawnSpec, '_tag'>): PtySpawnSpec => ({ _tag: 'Spawn', ...input }),
  server: (input: Omit<PtyServerSpec, '_tag'>): PtyServerSpec => ({ _tag: 'Server', ...input }),
}
