import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ABSENCE_GRACE_MS,
  DEFAULT_ARCHIVE_RETENTION_MS,
  DEFAULT_POST_MERGE_GRACE_MS,
  DEFAULT_STORE_GC_CONFIG,
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
})
