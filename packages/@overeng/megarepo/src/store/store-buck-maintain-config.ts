import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

const DURATION = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/u
const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** Buck's compact duration syntax, represented in milliseconds for policy decisions. */
export const buckDurationMs = (duration: string): number => {
  const match = DURATION.exec(duration)
  return match === null ? Number.NaN : Number(match[1]) * (DURATION_UNITS[match[2]!] ?? Number.NaN)
}

const BuckDuration = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => {
    const milliseconds = buckDurationMs(value)
    return (
      Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= Number.MAX_SAFE_INTEGER
    )
  }),
).annotate({ identifier: 'Megarepo.BuckMaintain.Duration' })
const Bytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
)
const WorktreeRoot = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => !value.includes('\0')),
)
const UtcTime = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/u))
const OwnerPattern = Schema.NonEmptyString.check(
  Schema.makeFilter((value) => value.trim() === value && !value.includes('\0') && value !== 'any'),
)
/** Strict versioned on-disk policy; only omitted fields receive defaults. */
export const StoreBuckMaintainConfigFile = Schema.Struct({
  version: Schema.Literal(1),
  worktreeRoots: Schema.optionalKey(Schema.Array(WorktreeRoot)),
  buckOut: Schema.optionalKey(
    Schema.Struct({
      budgetBytes: Schema.optionalKey(Bytes),
      keepSince: Schema.optionalKey(BuckDuration),
      fullCleanWhenInactiveFor: Schema.optionalKey(BuckDuration),
    }),
  ),
  daemon: Schema.optionalKey(Schema.Struct({ idleStopAfter: Schema.optionalKey(BuckDuration) })),
  blackout: Schema.optionalKey(Schema.Array(Schema.Struct({ startUtc: UtcTime, endUtc: UtcTime }))),
  maintainOwners: Schema.optionalKey(Schema.Array(OwnerPattern)),
  maintainUnowned: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: 'Megarepo.BuckMaintain.ConfigV1' })
export type StoreBuckMaintainConfigFile = typeof StoreBuckMaintainConfigFile.Type

/** Resolved policy. No host paths or owner identities are embedded in defaults. */
export interface StoreBuckMaintainConfig {
  readonly version: 1
  readonly worktreeRoots: readonly string[]
  readonly buckOut: {
    readonly budgetBytes: number
    readonly keepSince: string
    readonly fullCleanWhenInactiveFor?: string
  }
  readonly daemon: { readonly idleStopAfter: string }
  readonly blackout: readonly { readonly startUtc: string; readonly endUtc: string }[]
  readonly maintainOwners: readonly string[]
  readonly maintainUnowned: boolean
}

/** Neutral defaults; the daemon idle interval is policy, not a measured optimum. */
export const DEFAULT_STORE_BUCK_MAINTAIN_CONFIG: StoreBuckMaintainConfig = {
  version: 1,
  worktreeRoots: [],
  buckOut: { budgetBytes: 2_147_483_648, keepSince: '24h' },
  daemon: { idleStopAfter: '30m' },
  blackout: [],
  maintainOwners: [],
  maintainUnowned: false,
}

/** Invalid or unreadable maintenance configuration. */
export class StoreBuckMaintainConfigError extends Schema.TaggedError<StoreBuckMaintainConfigError>()(
  'StoreBuckMaintainConfigError',
  { message: Schema.String },
) {}

/** Invalid policy fails closed; it never silently falls back to defaults. */
export const decodeStoreBuckMaintainConfig = Effect.fn('store.decodeStoreBuckMaintainConfig')(
  function* (content: string) {
    const value = yield* Schema.decodeEffect(Schema.fromJsonString(StoreBuckMaintainConfigFile), {
      onExcessProperty: 'error',
    })(content).pipe(
      Effect.mapError(
        (cause) =>
          new StoreBuckMaintainConfigError({
            message: `Invalid Buck maintenance config: ${String(cause)}`,
          }),
      ),
    )
    const config: StoreBuckMaintainConfig = {
      version: 1,
      worktreeRoots: value.worktreeRoots ?? [],
      buckOut: {
        budgetBytes:
          value.buckOut?.budgetBytes ?? DEFAULT_STORE_BUCK_MAINTAIN_CONFIG.buckOut.budgetBytes,
        keepSince: value.buckOut?.keepSince ?? DEFAULT_STORE_BUCK_MAINTAIN_CONFIG.buckOut.keepSince,
        ...(value.buckOut?.fullCleanWhenInactiveFor === undefined
          ? {}
          : {
              fullCleanWhenInactiveFor: value.buckOut.fullCleanWhenInactiveFor,
            }),
      },
      daemon: {
        idleStopAfter:
          value.daemon?.idleStopAfter ?? DEFAULT_STORE_BUCK_MAINTAIN_CONFIG.daemon.idleStopAfter,
      },
      blackout: value.blackout ?? [],
      maintainOwners: value.maintainOwners ?? [],
      maintainUnowned: value.maintainUnowned ?? false,
    }
    return config
  },
)

/** Load and strictly decode a versioned configuration, or return neutral defaults. */
export const loadStoreBuckMaintainConfig = Effect.fn('store.loadStoreBuckMaintainConfig')(
  function* ({ path }: { readonly path?: string }) {
    if (path === undefined) return DEFAULT_STORE_BUCK_MAINTAIN_CONFIG
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (cause) =>
          new StoreBuckMaintainConfigError({
            message: `Cannot read Buck maintenance config ${path}: ${String(cause)}`,
          }),
      ),
    )
    return yield* decodeStoreBuckMaintainConfig(content)
  },
)
