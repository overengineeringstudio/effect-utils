import { describe, expect, it } from '@effect/vitest'

import { compareCanonicalPlanPaths } from '../cli/commands/store/mod.ts'

describe('generated artifact plan ordering', () => {
  it('uses deterministic UTF-8 byte ordering for distinct Unicode paths', () => {
    const paths = ['/store/z', '/store/\u00e9', '/store/e\u0301', '/store/a']

    expect(paths.toSorted((left, right) => compareCanonicalPlanPaths({ left, right }))).toEqual([
      '/store/a',
      '/store/e\u0301',
      '/store/z',
      '/store/\u00e9',
    ])
    expect(compareCanonicalPlanPaths({ left: '/store/\u00e9', right: '/store/e\u0301' })).not.toBe(
      0,
    )
  })
})
