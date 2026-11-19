import { Schema } from 'effect'

/** Historical checkpoint failures never authorize an acting maintenance run. */
export class BuckMaintainProgressError extends Schema.TaggedError<BuckMaintainProgressError>()(
  'BuckMaintainProgressError',
  { message: Schema.String },
) {}

const fail = (message: string) => new BuckMaintainProgressError({ message })
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Timestamp = Schema.Number.check(Schema.makeFilter((n) => Number.isFinite(n) && n >= 0))
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))
const RuntimeIdentity = Schema.Struct({
  entrypoint: Schema.String,
  entrypointSha256: Digest,
  executable: Schema.String,
  executableSha256: Digest,
  platform: Schema.String,
  arch: Schema.String,
})
const Entry = Schema.Struct({
  worktree: Schema.String,
  action: Schema.Literals(['none', 'clean-stale', 'full-clean', 'stop-daemon']),
  reason: Schema.String,
  bytesBefore: Schema.NullOr(Count),
  bytesAfter: Schema.NullOr(Count),
  daemon: Schema.Array(Schema.Struct({
    pid: Count,
    isolation: Schema.String,
    outcome: Schema.Literals(['not-attempted', 'would-stop', 'stopped', 'kept-active', 'unreachable']),
    reason: Schema.optional(Schema.String),
  })),
  ownerEvidence: Schema.Array(Schema.Struct({
    source: Schema.Literals(['process', 'st3-seat']),
    owner: Schema.NullOr(Schema.String),
    pid: Schema.optionalKey(Count),
    workspace: Schema.optionalKey(Schema.String),
  })),
})
const Timing = Schema.Struct({ startedAt: Timestamp, completedAt: Timestamp, elapsedMs: Timestamp })
export type BuckMaintainCaptureTimes = typeof Timing.Type
export const BuckMaintainProgressManifestSchema = Schema.Struct({
  version: Schema.Literal(1),
  dryRun: Schema.Literal(true),
  runtime: RuntimeIdentity,
  configuration: Schema.String,
  inventory: Schema.Array(Schema.String),
  createdAt: Timestamp,
})
export type BuckMaintainProgressManifest = typeof BuckMaintainProgressManifestSchema.Type
export const BuckMaintainProgressRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  manifestSha256: Digest,
  recordSha256: Digest,
  index: Count,
  entry: Entry,
  capture: Timing,
})
export type BuckMaintainProgressRecord = typeof BuckMaintainProgressRecordSchema.Type

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))

/** Stable object ordering; array ordering remains meaningful unless normalized by the caller. */
export const canonicalBuckMaintainJson = (value: unknown): string => {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize)
    if (input !== null && typeof input === 'object') return Object.fromEntries(
      Object.entries(input).filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => [key, normalize(item)]),
    )
    return input
  }
  return encode(normalize(value))
}

export const decodeBuckMaintainProgressManifest = Schema.decodeEffect(Schema.fromJsonString(BuckMaintainProgressManifestSchema), { onExcessProperty: 'error' })
export const decodeBuckMaintainProgressRecord = Schema.decodeEffect(Schema.fromJsonString(BuckMaintainProgressRecordSchema), { onExcessProperty: 'error' })

/** Validate before opening any checkpoint or entering the native maintenance runner. */
export const validateBuckMaintainProgressOptions = ({ dryRun, progressDir, maxWorktrees }: {
  dryRun: boolean; progressDir: string | undefined; maxWorktrees: number | undefined
}) => {
  if (progressDir === undefined && maxWorktrees !== undefined) return fail('--max-worktrees requires --progress-dir')
  if (progressDir !== undefined && dryRun !== true) return fail('--progress-dir requires explicit --dry-run; acting mode cannot resume historical observations')
  if (progressDir !== undefined && progressDir.trim() === '') return fail('--progress-dir must not be empty')
  if (maxWorktrees !== undefined && (!Number.isSafeInteger(maxWorktrees) || maxWorktrees < 1))
    return fail('--max-worktrees must be a positive safe integer')
  return undefined
}
