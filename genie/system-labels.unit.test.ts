import { describe, expect, it } from 'bun:test'

import { deriveSystemNames } from './system-labels.ts'

describe('multi-source system-name authority', () => {
  it('aliases and deduplicates directory, tracked-file, and explicit candidates together', () => {
    expect(deriveSystemNames({
      sources: [['zeta', 'alpha', 'implementation'], ['alpha', 'alias']],
      include: ['explicit', 'alias'],
      aliases: { alias: 'alpha', implementation: 'zeta' },
      descriptions: { alpha: 'Alpha', explicit: 'Explicit', zeta: 'Zeta' },
    })).toEqual(['alpha', 'explicit', 'zeta'])
  })

  it('classifies exclusions after resolving aliases', () => {
    expect(deriveSystemNames({
      sources: [['shard', 'system']], aliases: { shard: 'cross-cutting' },
      exclude: ['cross-cutting'], descriptions: { system: 'Named system' },
    })).toEqual(['system'])
  })

  it('rejects an unreviewed candidate regardless of which source supplied it', () => {
    expect(() => deriveSystemNames({ sources: [['known'], ['new']], descriptions: { known: 'Known' } }))
      .toThrow('new')
  })
})
