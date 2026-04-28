import { Context, Effect, Option } from 'effect'

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

/** Build stamp for a CLI running directly from a local source tree. */
export type LocalStamp = {
  readonly type: 'local'
  readonly rev: string
  readonly ts: number
  readonly dirty: boolean
}

/** Build stamp embedded by Nix at build time. */
export type NixStamp = {
  readonly type: 'nix'
  readonly version: string
  readonly rev: string
  readonly commitTs: number
  /** Only present for intentionally impure builds. */
  readonly buildTs?: number
  readonly dirty: boolean
}

/** Discriminated union of build stamp types used to resolve CLI version strings. */
export type CliStamp = LocalStamp | NixStamp

/** Structured build identity shared by CLIs, UIs, diagnostics, and telemetry. */
export type CliBuildIdentity = {
  readonly baseVersion: string
  readonly displayVersion: string
  readonly machineVersion: string
  readonly sourceKind: 'package' | 'local' | 'nix'
  readonly rev?: string
  readonly dirty: boolean
  readonly commitTs?: number
  readonly buildTs?: number
}

type VersionEnv = {
  readonly [key: string]: string | undefined
}

/**
 * Format a Unix timestamp as a human-readable relative time.
 * Uses medium formatting: "5 min ago", "2 hours ago", "3 days ago", "Jan 15"
 */
const formatRelativeTime = ({ ts, now }: { ts: number; now: number }): string => {
  const diffSeconds = now - ts

  if (diffSeconds < 60) {
    return 'just now'
  }

  const diffMinutes = Math.floor(diffSeconds / 60)
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`
  }

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) {
    return `${diffDays} ${diffDays === 1 ? 'day' : 'days'} ago`
  }

  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7)
    return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} ago`
  }

  // For older builds, show the date
  const date = new Date(ts * 1000)
  const month = date.toLocaleString('en-US', { month: 'short' })
  const day = date.getDate()
  return `${month} ${day}`
}

/**
 * Parse a JSON string as a CliStamp (LocalStamp or NixStamp).
 */
export const parseCliBuildStamp = (stamp: string): CliStamp | undefined => {
  try {
    const parsed = JSON.parse(stamp)
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined
    }

    if (parsed.type === 'local') {
      if (
        typeof parsed.rev === 'string' &&
        typeof parsed.ts === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        return { type: 'local', rev: parsed.rev, ts: parsed.ts, dirty: parsed.dirty }
      }
    } else if (parsed.type === 'nix') {
      if (
        typeof parsed.version === 'string' &&
        typeof parsed.rev === 'string' &&
        typeof parsed.commitTs === 'number' &&
        typeof parsed.dirty === 'boolean'
      ) {
        const buildTs = typeof parsed.buildTs === 'number' ? parsed.buildTs : undefined
        return {
          type: 'nix',
          version: parsed.version,
          rev: parsed.rev,
          commitTs: parsed.commitTs,
          ...(buildTs === undefined ? {} : { buildTs }),
          dirty: parsed.dirty,
        }
      }
    }
  } catch {
    // Invalid JSON
  }
  return undefined
}

/**
 * Render version string for a LocalStamp.
 *
 * Output examples:
 * - dirty:  "0.1.0 — running from local source (abc123, 5 min ago, with uncommitted changes)"
 * - clean:  "0.1.0 — running from local source (abc123, 2 hours ago)"
 */
const renderLocalVersion = ({
  baseVersion,
  stamp,
  now,
}: {
  baseVersion: string
  stamp: LocalStamp
  now: number
}): string => {
  const timeAgo = formatRelativeTime({ ts: stamp.ts, now })
  const dirtyNote = stamp.dirty === true ? ', with uncommitted changes' : ''
  return `${baseVersion} — running from local source (${stamp.rev}, ${timeAgo}${dirtyNote})`
}

/**
 * Render version string for a NixStamp.
 *
 * Output examples:
 * - pure, clean:   "0.1.0+def456 — committed 3 days ago"
 * - pure, dirty:   "0.1.0+def456-dirty — committed 3 days ago, with uncommitted changes"
 * - impure, clean: "0.1.0+def456 — built 2 hours ago"
 * - impure, dirty: "0.1.0+def456-dirty — built 2 hours ago, with uncommitted changes"
 */
const nixMachineVersion = (stamp: NixStamp): string => {
  const revAlreadyHasDirty = stamp.rev.endsWith('-dirty')
  const dirtySuffix = stamp.dirty === true && revAlreadyHasDirty === false ? '-dirty' : ''
  return `${stamp.version}+${stamp.rev}${dirtySuffix}`
}

const localMachineVersion = ({
  baseVersion,
  stamp,
}: {
  baseVersion: string
  stamp: LocalStamp
}): string => `${baseVersion}+local.${stamp.rev}${stamp.dirty === true ? '.dirty' : ''}`

const renderNixVersion = ({ stamp, now }: { stamp: NixStamp; now: number }): string => {
  const versionStr = nixMachineVersion(stamp)
  const dirtyNote = stamp.dirty === true ? ', with uncommitted changes' : ''

  if (stamp.buildTs !== undefined) {
    const timeAgo = formatRelativeTime({ ts: stamp.buildTs, now })
    return `${versionStr} — built ${timeAgo}${dirtyNote}`
  }

  const timeAgo = formatRelativeTime({ ts: stamp.commitTs, now })
  return `${versionStr} — committed ${timeAgo}${dirtyNote}`
}

/**
 * Resolve the full CLI build identity from the embedded build stamp and optional runtime stamp.
 */
export const resolveCliBuildIdentity = (options: {
  readonly baseVersion: string
  readonly buildStamp: string
  readonly env?: VersionEnv
  readonly now?: number
  readonly runtimeStampEnvVar?: string
}): CliBuildIdentity => {
  const {
    baseVersion,
    buildStamp,
    env = process.env,
    now = Math.floor(Date.now() / 1000),
    runtimeStampEnvVar = 'CLI_BUILD_STAMP',
  } = options
  const buildTimeStamp = parseCliBuildStamp(buildStamp)

  if (buildTimeStamp?.type === 'nix') {
    return {
      baseVersion,
      displayVersion: renderNixVersion({ stamp: buildTimeStamp, now }),
      machineVersion: nixMachineVersion(buildTimeStamp),
      sourceKind: 'nix',
      rev: buildTimeStamp.rev,
      dirty: buildTimeStamp.dirty,
      commitTs: buildTimeStamp.commitTs,
      ...(buildTimeStamp.buildTs === undefined ? {} : { buildTs: buildTimeStamp.buildTs }),
    }
  }

  const runtimeStampRaw = env[runtimeStampEnvVar]?.trim()
  const runtimeStamp =
    runtimeStampRaw === undefined || runtimeStampRaw.length === 0
      ? undefined
      : parseCliBuildStamp(runtimeStampRaw)

  if (runtimeStamp?.type === 'local') {
    return {
      baseVersion,
      displayVersion: renderLocalVersion({ baseVersion, stamp: runtimeStamp, now }),
      machineVersion: localMachineVersion({ baseVersion, stamp: runtimeStamp }),
      sourceKind: 'local',
      rev: runtimeStamp.rev,
      dirty: runtimeStamp.dirty,
      buildTs: runtimeStamp.ts,
    }
  }

  return {
    baseVersion,
    displayVersion: baseVersion,
    machineVersion: baseVersion,
    sourceKind: 'package',
    dirty: false,
  }
}

/**
 * Resolve the machine-readable CLI version suitable for telemetry, logs, and protocol payloads.
 */
export const resolveCliMachineVersion = (
  options: Parameters<typeof resolveCliBuildIdentity>[0],
): string => resolveCliBuildIdentity(options).machineVersion

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
}): string => resolveCliBuildIdentity(options).displayVersion
