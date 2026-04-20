import { Context, Effect, Option } from 'effect'

import { resolveCliBuildIdentity } from './cli-build-identity.ts'

export type {
  CliBuildIdentity,
  CliBuildSourceKind,
  CliStamp,
  LocalStamp,
  NixStamp,
} from './cli-build-identity.ts'
export { resolveCliBuildIdentity } from './cli-build-identity.ts'

/** CLI name and version pair, provided at startup for error diagnostics. */
export interface CliVersionInfo {
  readonly name: string
  readonly version: string
}

/** CLI identity and version, provided at startup for error diagnostics. */
export class CliVersion extends Context.Tag('CliVersion')<CliVersion, CliVersionInfo>() {
  /**
   * Yield a version suffix for use in error messages.
   * Returns e.g. `" (genie 0.1.0+abc123)"` or `""` if `CliVersion` is not provided.
   */
  static suffix: Effect.Effect<string> = Effect.serviceOption(CliVersion).pipe(
    Effect.map((v) => (Option.isSome(v) === true ? ` (${v.value.name} ${v.value.version})` : '')),
  )

  /**
   * Enrich all typed error messages with a version suffix.
   * Apply once in the CLI pipe chain — all errors with a `message` field get annotated automatically.
   *
   * @example
   * ```ts
   * effect.pipe(
   *   CliVersion.enrichErrors,
   *   Effect.provideService(CliVersion, { name: 'mr', version }),
   *   runTuiMain(NodeRuntime),
   * )
   * ```
   */
  static enrichErrors = <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.flatMap(Effect.serviceOption(CliVersion), (infoOpt) => {
      if (Option.isNone(infoOpt) === true) return self
      const suffix = ` (${infoOpt.value.name} ${infoOpt.value.version})`
      return self.pipe(
        Effect.mapError((error) => {
          if (
            typeof error === 'object' &&
            error !== null &&
            'message' in error &&
            typeof (error as any).message === 'string'
          ) {
            return Object.assign(Object.create(Object.getPrototypeOf(error)), error, {
              message: `${(error as any).message}${suffix}`,
            }) as E
          }
          return error
        }),
      )
    })
}

/**
 * Resolve the CLI version from build stamp and optional runtime stamp.
 *
 * @param baseVersion - The package.json version (used for local builds)
 * @param buildStamp - JSON stamp embedded at build time, or placeholder '__CLI_BUILD_STAMP__'
 * @param runtimeStampEnvVar - Environment variable name for runtime stamp (default: 'CLI_BUILD_STAMP')
 */
export const resolveCliVersion = (options: {
  baseVersion: string
  buildStamp: string
  runtimeStampEnvVar?: string
}): string => {
  return resolveCliBuildIdentity(options).displayVersion
}
