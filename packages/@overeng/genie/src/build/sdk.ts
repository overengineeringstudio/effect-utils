import path from 'node:path'

import { type Error as PlatformError, FileSystem } from '@effect/platform'
import type * as CommandExecutor from '@effect/platform/CommandExecutor'
import type { Path } from '@effect/platform/Path'
import { Effect, Layer, Option, PubSub } from 'effect'

import { type GenieGenerateResult, checkAll, generateAll, resolveOxfmtConfigPath } from './core.ts'
import type { GenieGenerationFailedError } from './errors.ts'
import { type GenieEvent, GenieEventBus } from './events.ts'

export type { GenieGenerateResult } from './core.ts'
export type { GenieSummary } from './schema.ts'
export type { GenerateSuccess } from './types.sdk.ts'
export { GenieCheckError, GenieGenerationFailedError, GenieImportError } from './errors.ts'
export { type GenieEvent, GenieEventBus } from './events.ts'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type GenieGenerateOptions = {
  cwd: string
  writeable?: boolean
  dryRun?: boolean
  env?: Record<string, string>
  oxfmtConfigPath?: string
}

export type GenieCheckOptions = {
  cwd: string
  env?: Record<string, string>
  oxfmtConfigPath?: string
}

/** Temporarily set env vars, run an effect, then restore original values. */
const withEnv = <A, E, R>(
  env: Record<string, string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const saved: Record<string, string | undefined> = {}
      for (const [key, value] of Object.entries(env)) {
        saved[key] = process.env[key]
        process.env[key] = value
      }
      return saved
    }),
    () => effect,
    (saved) =>
      Effect.sync(() => {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key]
          } else {
            process.env[key] = value
          }
        }
      }),
  )

/** Resolve cwd to a real path, normalizing symlinks. */
const resolveCwd = (inputCwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const absoluteCwd = path.isAbsolute(inputCwd) ? inputCwd : path.resolve(inputCwd)
    return yield* fs.realPath(absoluteCwd).pipe(Effect.catchAll(() => Effect.succeed(absoluteCwd)))
  })

/** Provide a no-subscriber event bus (events are silently dropped). */
const withSilentEventBus = <A, E, R>(
  effect: Effect.Effect<A, E, R | GenieEventBus>,
): Effect.Effect<A, E, Exclude<R, GenieEventBus>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const bus = yield* PubSub.unbounded<GenieEvent>()
      return yield* effect.pipe(Effect.provideService(GenieEventBus, bus))
    }),
  ) as Effect.Effect<A, E, Exclude<R, GenieEventBus>>

/** Generate files from all discovered .genie.ts sources. */
export const generate = ({
  cwd: inputCwd,
  writeable = false,
  dryRun = false,
  env,
  oxfmtConfigPath: explicitOxfmtPath,
}: GenieGenerateOptions): Effect.Effect<
  GenieGenerateResult,
  GenieGenerationFailedError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path | CommandExecutor.CommandExecutor
> => {
  const core = Effect.gen(function* () {
    const cwd = yield* resolveCwd(inputCwd)
    const oxfmtConfigPath = yield* resolveOxfmtConfigPath({
      explicitPath: explicitOxfmtPath ? Option.some(explicitOxfmtPath) : Option.none(),
      cwd,
    })
    return yield* withSilentEventBus(
      generateAll({ cwd, readOnly: !writeable, dryRun, oxfmtConfigPath }),
    )
  })

  if (env && Object.keys(env).length > 0) {
    return withEnv(env, core)
  }
  return core
}

/** Check that all generated files are up to date. */
export const check = ({
  cwd: inputCwd,
  env,
  oxfmtConfigPath: explicitOxfmtPath,
}: GenieCheckOptions): Effect.Effect<
  void,
  GenieGenerationFailedError | PlatformError.PlatformError,
  FileSystem.FileSystem | Path | CommandExecutor.CommandExecutor
> => {
  const core = Effect.gen(function* () {
    const cwd = yield* resolveCwd(inputCwd)
    const oxfmtConfigPath = yield* resolveOxfmtConfigPath({
      explicitPath: explicitOxfmtPath ? Option.some(explicitOxfmtPath) : Option.none(),
      cwd,
    })
    return yield* withSilentEventBus(checkAll({ cwd, oxfmtConfigPath }))
  })

  if (env && Object.keys(env).length > 0) {
    return withEnv(env, core)
  }
  return core
}
