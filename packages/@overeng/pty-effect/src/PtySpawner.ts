import { Context, Effect, Layer } from 'effect'
import type { Scope } from 'effect'

import type { PtyError } from './PtyError.ts'
import * as PtySession from './PtySession.ts'
import type { PtySpec } from './PtySpec.ts'

/**
 * Service for spawning `PtySession`s.
 *
 * Following the `@effect/platform` `CommandExecutor` pattern: a `Context.Tag`
 * class with a `spawn` method that returns a `Scope`-bound resource. The
 * caller's scope owns the lifecycle.
 */
export class PtySpawner extends Context.Tag('@overeng/pty-effect/PtySpawner')<
  PtySpawner,
  {
    readonly spawn: (spec: PtySpec) => Effect.Effect<PtySession.PtySession, PtyError, Scope.Scope>
  }
>() {}

/**
 * Default in-process layer.
 *
 * Wraps `@myobie/pty/testing`'s `Session.spawn` / `Session.server`. No
 * external daemon, no socket files outside what the upstream library itself
 * creates (server mode only). For complete isolation in tests, set
 * `PTY_SESSION_DIR` to a per-test temp directory before constructing the
 * layer (see `tmp/` examples in the test file).
 */
export const layer: Layer.Layer<PtySpawner> = Layer.succeed(
  PtySpawner,
  PtySpawner.of({
    spawn: (spec) => PtySession.make(spec),
  }),
)

/** Convenience: spawn through the layer in one call. */
export const spawn = (spec: PtySpec) => Effect.flatMap(PtySpawner, (s) => s.spawn(spec))
