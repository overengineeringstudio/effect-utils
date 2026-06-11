/**
 * GC reclamation config (three timers, decision 0008).
 *
 * Defaults are conservative-generous because the cold population is dominated
 * by worktrees much older than the windows. A host may override any subset via
 * `$STORE/.state/gc-config.json`; provided keys are merged over the defaults and
 * unknown/invalid files fall back to the defaults (never fail the gc path).
 */

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Schema } from 'effect'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

const DAY_MS = 24 * 60 * 60 * 1000

/** Default: a worktree must be absent from ALL live sets this long before archive eligibility. */
export const DEFAULT_ABSENCE_GRACE_MS = 14 * DAY_MS

/** Default: do not archive until at least this long after the PR's `mergedAt`. */
export const DEFAULT_POST_MERGE_GRACE_MS = 7 * DAY_MS

/** Default: an archived worktree is reaped once it has been archived this long. */
export const DEFAULT_ARCHIVE_RETENTION_MS = 30 * DAY_MS

/** Fully-resolved reclamation timers in epoch-ms durations. */
export interface StoreGcConfig {
  readonly absenceGraceMs: number
  readonly postMergeGraceMs: number
  readonly archiveRetentionMs: number
}

/** Defaults applied when no override file is present (or it is invalid). */
export const DEFAULT_STORE_GC_CONFIG: StoreGcConfig = {
  absenceGraceMs: DEFAULT_ABSENCE_GRACE_MS,
  postMergeGraceMs: DEFAULT_POST_MERGE_GRACE_MS,
  archiveRetentionMs: DEFAULT_ARCHIVE_RETENTION_MS,
} as const

/** On-disk override shape: every key optional; only provided keys override defaults. */
const StoreGcConfigOverride = Schema.Struct({
  absenceGraceMs: Schema.optional(Schema.Number),
  postMergeGraceMs: Schema.optional(Schema.Number),
  archiveRetentionMs: Schema.optional(Schema.Number),
})

/** Parsed `gc-config.json` override: every timer optional. */
export type StoreGcConfigOverride = Schema.Schema.Type<typeof StoreGcConfigOverride>

/** Relative path of the override file within the store. */
export const GC_CONFIG_RELATIVE_PATH = '.state/gc-config.json'

const gcConfigPath = (storeBasePath: AbsoluteDirPath) =>
  EffectPath.ops.join(storeBasePath, EffectPath.unsafe.relativeFile(GC_CONFIG_RELATIVE_PATH))

/**
 * Merge a parsed override over the defaults.
 *
 * Only keys actually present in the override take effect; `undefined` keys keep
 * the default. Pure so it is the unit-tested seam for the merge contract.
 */
export const mergeStoreGcConfig = (override: StoreGcConfigOverride): StoreGcConfig => ({
  absenceGraceMs: override.absenceGraceMs ?? DEFAULT_STORE_GC_CONFIG.absenceGraceMs,
  postMergeGraceMs: override.postMergeGraceMs ?? DEFAULT_STORE_GC_CONFIG.postMergeGraceMs,
  archiveRetentionMs: override.archiveRetentionMs ?? DEFAULT_STORE_GC_CONFIG.archiveRetentionMs,
})

/**
 * Load the effective gc config from `$STORE/.state/gc-config.json`.
 *
 * Absent file ⇒ defaults. Unreadable or invalid file ⇒ defaults (the gc path
 * must not fail on a malformed override; defaults are the safe fallback).
 */
export const loadStoreGcConfig = ({
  storeBasePath,
}: {
  storeBasePath: AbsoluteDirPath
}): Effect.Effect<StoreGcConfig, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = gcConfigPath(storeBasePath)
    const override = yield* fs.readFileString(path).pipe(
      Effect.flatMap((content) =>
        Schema.decodeUnknown(Schema.parseJson(StoreGcConfigOverride))(content),
      ),
      Effect.catchAll(() => Effect.succeed({} as StoreGcConfigOverride)),
    )
    return mergeStoreGcConfig(override)
  }).pipe(
    Effect.withSpan('megarepo/store/gc/load-config', {
      attributes: { 'span.label': 'gc-config' },
    }),
  )
