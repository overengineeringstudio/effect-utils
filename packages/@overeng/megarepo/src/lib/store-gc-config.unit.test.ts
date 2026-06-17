import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { it as effectIt } from '@effect/vitest'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import {
  DEFAULT_ABSENCE_GRACE_MS,
  DEFAULT_ARCHIVE_RETENTION_MS,
  DEFAULT_POST_MERGE_GRACE_MS,
  DEFAULT_STORE_GC_CONFIG,
  GC_CONFIG_RELATIVE_PATH,
  loadStoreGcConfig,
  mergeStoreGcConfig,
} from './store-gc-config.ts'

describe('store-gc-config', () => {
  describe('defaults', () => {
    it('matches the three-timer decision (0008): 14d / 7d / 30d', () => {
      const day = 24 * 60 * 60 * 1000
      expect(DEFAULT_ABSENCE_GRACE_MS).toBe(14 * day)
      expect(DEFAULT_POST_MERGE_GRACE_MS).toBe(7 * day)
      expect(DEFAULT_ARCHIVE_RETENTION_MS).toBe(30 * day)
    })
  })

  describe('mergeStoreGcConfig', () => {
    it('empty override yields the defaults verbatim', () => {
      expect(mergeStoreGcConfig({})).toEqual(DEFAULT_STORE_GC_CONFIG)
    })

    it('overrides only the provided keys, keeping defaults for the rest', () => {
      expect(mergeStoreGcConfig({ absenceGraceMs: 1000 })).toEqual({
        absenceGraceMs: 1000,
        postMergeGraceMs: DEFAULT_POST_MERGE_GRACE_MS,
        archiveRetentionMs: DEFAULT_ARCHIVE_RETENTION_MS,
      })
    })

    it('overrides all three keys', () => {
      expect(
        mergeStoreGcConfig({ absenceGraceMs: 1, postMergeGraceMs: 2, archiveRetentionMs: 3 }),
      ).toEqual({ absenceGraceMs: 1, postMergeGraceMs: 2, archiveRetentionMs: 3 })
    })

    it('treats an explicit zero as a real override (not falsy fallback)', () => {
      expect(mergeStoreGcConfig({ postMergeGraceMs: 0 }).postMergeGraceMs).toBe(0)
    })
  })

  describe('loadStoreGcConfig', () => {
    const writeConfig = (content: string) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const storeBasePath = EffectPath.unsafe.absoluteDir(
          `${yield* fs.makeTempDirectoryScoped()}/`,
        )
        const configPath = EffectPath.ops.join(
          storeBasePath,
          EffectPath.unsafe.relativeFile(GC_CONFIG_RELATIVE_PATH),
        )
        const configDir = EffectPath.ops.parent(configPath)!
        yield* fs.makeDirectory(configDir, { recursive: true })
        yield* fs.writeFileString(configPath, content)
        return storeBasePath
      })

    effectIt.effect(
      'absent file ⇒ defaults',
      Effect.fnUntraced(
        function* () {
          const fs = yield* FileSystem.FileSystem
          const storeBasePath = EffectPath.unsafe.absoluteDir(
            `${yield* fs.makeTempDirectoryScoped()}/`,
          )
          expect(yield* loadStoreGcConfig({ storeBasePath })).toEqual(DEFAULT_STORE_GC_CONFIG)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    effectIt.effect(
      'valid override file ⇒ merged timers reflect it',
      Effect.fnUntraced(
        function* () {
          const storeBasePath = yield* writeConfig(
            JSON.stringify({ absenceGraceMs: 1234, archiveRetentionMs: 5678 }),
          )
          expect(yield* loadStoreGcConfig({ storeBasePath })).toEqual({
            absenceGraceMs: 1234,
            postMergeGraceMs: DEFAULT_POST_MERGE_GRACE_MS,
            archiveRetentionMs: 5678,
          })
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )

    effectIt.effect(
      'corrupt file ⇒ DEFAULT_STORE_GC_CONFIG without error',
      Effect.fnUntraced(
        function* () {
          const storeBasePath = yield* writeConfig('{ not valid json ::: }')
          // Degrades to defaults rather than failing the gc path.
          expect(yield* loadStoreGcConfig({ storeBasePath })).toEqual(DEFAULT_STORE_GC_CONFIG)
        },
        Effect.provide(NodeContext.layer),
        Effect.scoped,
      ),
    )
  })
})
