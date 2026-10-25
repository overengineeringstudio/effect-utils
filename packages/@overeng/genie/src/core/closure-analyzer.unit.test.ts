import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import { createClosureAnalyzer, matchDependencyAllowlist } from './closure-analyzer.ts'
import type { DependencyAllowlistEntry } from './closure-analyzer.ts'

const entry: DependencyAllowlistEntry = {
  name: 'reviewed-fixture',
  version: '1.2.3',
  integrity: 'sha512-original',
  reason: 'Owner-reviewed pure transformation code.',
  files: [
    { path: 'dist/index.js', digest: 'a'.repeat(64) },
    { path: 'dist/helper.js', digest: 'b'.repeat(64) },
  ],
}

describe('reviewed dependency allowlist', () => {
  it('starts empty and requires exact package, version, and integrity with a review reason', () => {
    expect(matchDependencyAllowlist({ identity: entry })).toBeUndefined()
    expect(matchDependencyAllowlist({ identity: entry, entries: [entry] })).toEqual(entry)
    for (const changed of [
      { ...entry, name: 'other-package' },
      { ...entry, version: '1.2.4' },
      { ...entry, integrity: 'sha512-mutated' },
    ])
      expect(matchDependencyAllowlist({ identity: changed, entries: [entry] })).toBeUndefined()
    expect(
      matchDependencyAllowlist({ identity: entry, entries: [{ ...entry, reason: ' ' }] }),
    ).toBeUndefined()
  })

  it('de-lists integrity mutations without affecting an unchanged peer', () => {
    const peer = { ...entry, name: 'peer-fixture' }
    const entries = [entry, peer]
    expect(
      matchDependencyAllowlist({
        identity: { ...entry, integrity: 'sha512-replaced' },
        entries: entries,
      }),
    ).toBeUndefined()
    expect(matchDependencyAllowlist({ identity: peer, entries: entries })).toEqual(peer)
  })

  it('requires approved loaded bytes even when package identity and lock integrity are unchanged', () => {
    const loaded = { ...entry, files: [entry.files[0]!] }
    expect(matchDependencyAllowlist({ identity: loaded, entries: [entry] })).toEqual(entry)
    expect(
      matchDependencyAllowlist({
        identity: { ...loaded, files: [{ path: 'dist/index.js', digest: 'c'.repeat(64) }] },
        entries: [entry],
      }),
    ).toBeUndefined()
    expect(
      matchDependencyAllowlist({
        identity: { ...loaded, files: [{ path: 'dist/unapproved.js', digest: 'a'.repeat(64) }] },
        entries: [entry],
      }),
    ).toBeUndefined()
    expect(
      matchDependencyAllowlist({
        identity: {
          ...entry,
          files: [entry.files[0]!, { path: 'dist/helper.js', digest: 'c'.repeat(64) }],
        },
        entries: [entry],
      }),
    ).toBeUndefined()
    expect(
      matchDependencyAllowlist({ identity: { ...entry, files: [] }, entries: [entry] }),
    ).toBeUndefined()
    expect(
      matchDependencyAllowlist({
        identity: { ...loaded, files: [{ path: '../dist/index.js', digest: 'a'.repeat(64) }] },
        entries: [entry],
      }),
    ).toBeUndefined()
  })
})

describe('compiler availability boundary', () => {
  it('does not acquire a compiler session when read-set analysis is unused', async () => {
    let acquisitions = 0
    const analyzer = createClosureAnalyzer({
      cacheDirectory: false,
      runAnalysis: async () => {
        acquisitions++
        throw new Error('Unexpected session')
      },
    })
    await analyzer.close()
    expect(acquisitions).toBe(0)
  })

  it('fails closed for a missing project and shares one session across cold modules', async () => {
    let acquisitions = 0
    let closes = 0
    const analyzer = createClosureAnalyzer({
      cacheDirectory: false,
      runAnalysis: async ({ use: runWithSession }) => {
        acquisitions++
        try {
          return await runWithSession({
            analyze: async () => ({ kind: 'failed', reason: 'No project' }),
          })
        } finally {
          closes++
        }
      },
    })
    try {
      for (const source of [
        'export const missingProjectA = 1',
        'export const missingProjectB = 2',
      ]) {
        const analysis = await analyzer.analyze({ source, filename: 'missing-project.ts' })
        expect(analysis.reasons).toEqual([
          {
            operation: 'analysis-unavailable',
            detail: 'The compiler could not supply a source AST.',
            line: null,
          },
        ])
      }
    } finally {
      await analyzer.close()
    }
    expect(acquisitions).toBe(1)
    expect(closes).toBe(1)
  })

  it('does not cache unavailable sessions as clean byte analysis', async () => {
    let acquisitions = 0
    for (let attempt = 0; attempt < 2; attempt++) {
      const analyzer = createClosureAnalyzer({
        cacheDirectory: false,
        runAnalysis: async () => {
          acquisitions++
          throw new Error('Server unavailable')
        },
      })
      try {
        const analysis = await analyzer.analyze({
          source: 'export const serverUnavailableFixture = true',
          filename: 'fixture.ts',
        })
        expect(analysis.reasons).toEqual([
          {
            operation: 'analysis-unavailable',
            detail: 'The compiler session could not analyze this module.',
            line: null,
          },
        ])
      } finally {
        await expect(analyzer.close()).rejects.toThrow('Server unavailable')
      }
    }
    expect(acquisitions).toBe(2)
  })
})
