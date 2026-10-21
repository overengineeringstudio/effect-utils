import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { encodeJson } from '../test-utils/mod.ts'
import {
  buckDurationMs,
  decodeStoreBuckMaintainConfig,
  DEFAULT_STORE_BUCK_MAINTAIN_CONFIG,
} from './store-buck-maintain-config.ts'

describe('Buck maintenance config', () => {
  it.effect('resolves neutral defaults without host or owner identities', () =>
    Effect.gen(function* () {
      expect(yield* decodeStoreBuckMaintainConfig('{"version":1}')).toEqual(
        DEFAULT_STORE_BUCK_MAINTAIN_CONFIG,
      )
    }),
  )

  it.effect('resolves partial nested overrides and preserves Buck duration syntax', () =>
    Effect.gen(function* () {
      const result = yield* decodeStoreBuckMaintainConfig(
        encodeJson({
          version: 1,
          worktreeRoots: ['/work'],
          buckOut: { budgetBytes: 0, fullCleanWhenInactiveFor: '48h' },
          daemon: { idleStopAfter: '15m' },
          blackout: [{ startUtc: '23:00', endUtc: '02:00' }],
          maintainOwners: ['seat/exact', 'seat/*', '*'],
          maintainUnowned: true,
        }),
      )
      expect(result.buckOut).toEqual({
        budgetBytes: 0,
        keepSince: '24h',
        fullCleanWhenInactiveFor: '48h',
      })
      expect(result.daemon.idleStopAfter).toBe('15m')
      expect(result.worktreeRoots).toEqual(['/work'])
      expect(result.maintainOwners).toEqual(['seat/exact', 'seat/*', '*'])
      expect(result.maintainUnowned).toBe(true)
    }),
  )

  it.effect('accepts config-relative worktree roots', () =>
    Effect.gen(function* () {
      const result = yield* decodeStoreBuckMaintainConfig(
        encodeJson({
          version: 1,
          worktreeRoots: ['.', '../other'],
        }),
      )
      expect(result.worktreeRoots).toEqual(['.', '../other'])
    }),
  )

  for (const [name, value] of Object.entries({
    'missing version': {},
    'unknown version': { version: 2 },
    'unknown field': { version: 1, extra: true },
    'unknown nested field': { version: 1, buckOut: { extra: true } },
    'negative bytes': { version: 1, buckOut: { budgetBytes: -1 } },
    'fractional bytes': { version: 1, buckOut: { budgetBytes: 0.5 } },
    'unsafe bytes': { version: 1, buckOut: { budgetBytes: Number.MAX_SAFE_INTEGER + 1 } },
    'nul path': { version: 1, worktreeRoots: ['/work\0'] },
    'negative duration': { version: 1, buckOut: { keepSince: '-1h' } },
    'unitless duration': { version: 1, daemon: { idleStopAfter: '30' } },
    'invalid duration': { version: 1, buckOut: { fullCleanWhenInactiveFor: 'forever' } },
    'overflow duration': { version: 1, buckOut: { keepSince: '999999999999999999h' } },
    'invalid utc hour': { version: 1, blackout: [{ startUtc: '24:00', endUtc: '02:00' }] },
    'invalid utc minute': { version: 1, blackout: [{ startUtc: '01:60', endUtc: '02:00' }] },
    'wrong utc keys': { version: 1, blackout: [{ start: '01:00', end: '02:00' }] },
    'any enum': { version: 1, maintainOwners: ['any'] },
    'empty owner': { version: 1, maintainOwners: [''] },
    'null override': { version: 1, daemon: null },
    'wrong boolean': { version: 1, maintainUnowned: 'true' },
  })) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const result = yield* decodeStoreBuckMaintainConfig(encodeJson(value)).pipe(Effect.result)
        expect(result._tag).toBe('Failure')
      }),
    )
  }

  it.effect('rejects malformed JSON', () =>
    Effect.gen(function* () {
      expect((yield* decodeStoreBuckMaintainConfig('{').pipe(Effect.result))._tag).toBe('Failure')
    }),
  )

  it('converts compact durations without changing config strings', () => {
    expect(buckDurationMs('24h')).toBe(86_400_000)
    expect(buckDurationMs('30m')).toBe(1_800_000)
    expect(buckDurationMs('1.5h')).toBe(5_400_000)
    expect(buckDurationMs('0s')).toBe(0)
    expect(buckDurationMs('invalid')).toBeNaN()
  })
})
