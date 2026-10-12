import { NodeServices } from '@effect/platform-node'
import { it as effectIt } from '@effect/vitest'
import { Effect } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, it } from 'vitest'

import { EffectPath } from '@overeng/effect-path'

import { encodeJson } from '../test-utils/mod.ts'
import {
  DEFAULT_ARCHIVE_RETENTION_MS,
  DEFAULT_POST_MERGE_GRACE_MS,
  DEFAULT_STORE_GC_CONFIG,
  GC_CONFIG_RELATIVE_PATH,
  loadStoreGcConfig,
  mergeStoreGcConfig,
} from './store-gc-config.ts'

describe('store-gc-config', () => {
  describe('mergeStoreGcConfig', () => {
    it('empty override yields the defaults verbatim', () => {
      expect(mergeStoreGcConfig({})).toEqual(DEFAULT_STORE_GC_CONFIG)
    })

    it('overrides only the provided keys, keeping defaults for the rest', () => {
      expect(mergeStoreGcConfig({ absenceGraceMs: 1000 })).toEqual({
        absenceGraceMs: 1000,
        postMergeGraceMs: DEFAULT_POST_MERGE_GRACE_MS,
        archiveRetentionMs: DEFAULT_ARCHIVE_RETENTION_MS,
        generatedArtifacts: DEFAULT_STORE_GC_CONFIG.generatedArtifacts,
      })
    })

    it('overrides all three keys', () => {
      expect(
        mergeStoreGcConfig({ absenceGraceMs: 1, postMergeGraceMs: 2, archiveRetentionMs: 3 }),
      ).toEqual({
        absenceGraceMs: 1,
        postMergeGraceMs: 2,
        archiveRetentionMs: 3,
        generatedArtifacts: DEFAULT_STORE_GC_CONFIG.generatedArtifacts,
      })
    })

    it('treats an explicit zero as a real override (not falsy fallback)', () => {
      expect(mergeStoreGcConfig({ postMergeGraceMs: 0 }).postMergeGraceMs).toBe(0)
    })

    it('fails safe to defaults for negative or non-finite durations', () => {
      const merged = mergeStoreGcConfig({
        absenceGraceMs: -1,
        generatedArtifacts: { retentionMs: Number.POSITIVE_INFINITY },
      })
      expect(merged.absenceGraceMs).toBe(DEFAULT_STORE_GC_CONFIG.absenceGraceMs)
      expect(merged.generatedArtifacts.retentionMs).toBe(
        DEFAULT_STORE_GC_CONFIG.generatedArtifacts.retentionMs,
      )
    })

    it('accepts an explicit generated-artifact retention and class policy', () => {
      expect(
        mergeStoreGcConfig({
          generatedArtifacts: {
            enabled: true,
            retentionMs: 42,
            allowlist: ['node_modules', 'storybook-static'],
          },
        }).generatedArtifacts,
      ).toEqual({
        enabled: true,
        retentionMs: 42,
        allowlist: ['node_modules', 'storybook-static'],
      })
    })

    it('deduplicates generated classes', () => {
      const generatedArtifacts = mergeStoreGcConfig({
        generatedArtifacts: {
          allowlist: ['node_modules', 'node_modules', '.direnv'],
        },
      }).generatedArtifacts

      expect(generatedArtifacts.allowlist).toEqual(['node_modules', '.direnv'])
    })

    it('keeps activity sources and the budgets policy path only when configured', () => {
      const merged = mergeStoreGcConfig({
        generatedArtifacts: {
          manifestPath: '/run/megarepo/workspace-activity.json',
          agentLivenessProducers: ['st3', 'st3'],
          builtin: false,
        },
        buildOutputBudgetsPath: '/etc/megarepo/build-output-budgets.json',
      })
      expect(merged.generatedArtifacts).toEqual({
        ...DEFAULT_STORE_GC_CONFIG.generatedArtifacts,
        manifestPath: '/run/megarepo/workspace-activity.json',
        agentLivenessProducers: ['st3'],
        builtin: false,
      })
      expect(merged.buildOutputBudgetsPath).toBe('/etc/megarepo/build-output-budgets.json')
      expect('buildOutputBudgetsPath' in mergeStoreGcConfig({})).toBe(false)
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
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    effectIt.effect(
      'valid override file ⇒ merged timers reflect it',
      Effect.fnUntraced(
        function* () {
          const storeBasePath = yield* writeConfig(
            encodeJson({ absenceGraceMs: 1234, archiveRetentionMs: 5678 }),
          )
          expect(yield* loadStoreGcConfig({ storeBasePath })).toEqual({
            absenceGraceMs: 1234,
            postMergeGraceMs: DEFAULT_POST_MERGE_GRACE_MS,
            archiveRetentionMs: 5678,
            generatedArtifacts: DEFAULT_STORE_GC_CONFIG.generatedArtifacts,
          })
        },
        Effect.provide(NodeServices.layer),
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
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )

    effectIt.effect(
      'relative activity manifest path ⇒ defaults (no unadmitted source)',
      Effect.fnUntraced(
        function* () {
          const storeBasePath = yield* writeConfig(
            encodeJson({ generatedArtifacts: { enabled: true, manifestPath: 'activity.json' } }),
          )
          expect(yield* loadStoreGcConfig({ storeBasePath })).toEqual(DEFAULT_STORE_GC_CONFIG)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  })
})
