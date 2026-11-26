import { describe, expect, it } from 'vitest'

import { checkCoverage, describeMissingCoverage, globToRegExp } from './enforcement.ts'

const config = { paths: ['src/**'], changelogDirectory: '.changelog' }

describe('globToRegExp', () => {
  it.each([
    ['src/**', 'src/app/Home.tsx', true],
    ['src/**', 'src', false],
    ['src/**/*.ts', 'src/a.ts', true],
    ['src/**/*.ts', 'src/a/b/c.ts', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['tests/helpers.ts', 'tests/helpers.ts', true],
    ['a?.md', 'ab.md', true],
    ['a.b', 'axb', false],
  ])('%s ~ %s → %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected)
  })
})

describe('checkCoverage', () => {
  it('needs nothing when no product source changed', () => {
    expect(
      checkCoverage({
        config,
        changedFiles: [{ path: 'README.md', status: 'M' }],
        commitMessages: [],
      }),
    ).toEqual({ _tag: 'NotRequired' })
  })

  it('accepts a newly added entry', () => {
    expect(
      checkCoverage({
        config,
        changedFiles: [
          { path: 'src/app/Home.tsx', status: 'M' },
          { path: '.changelog/2026-11-23-home.ts', status: 'A' },
        ],
        commitMessages: [],
      }),
    ).toEqual({ _tag: 'CoveredByEntry', entries: ['.changelog/2026-11-23-home.ts'] })
  })

  it('does not count edited entries, scenes or screenshots as new entries', () => {
    const result = checkCoverage({
      config,
      changedFiles: [
        { path: 'src/app/Home.tsx', status: 'M' },
        { path: '.changelog/2026-11-20-old.ts', status: 'M' },
        { path: '.changelog/2026-11-23-home.scene.ts', status: 'A' },
        { path: '.changelog/screenshots/2026-11-23-home.json', status: 'A' },
      ],
      commitMessages: [],
    })
    expect(result).toEqual({ _tag: 'Missing', sources: ['src/app/Home.tsx'] })
  })

  it.each([
    'refactor(games): split atoms\n\nchangelog: none — internal refactor',
    'fix: x\n\nChangelog: none -- test-only change',
    'fix: x\n\nchangelog:none – types only',
  ])('accepts a waiver line: %s', (message) => {
    const result = checkCoverage({
      config,
      changedFiles: [{ path: 'src/a.ts', status: 'M' }],
      commitMessages: ['feat: other', message],
    })
    expect(result._tag).toBe('Waived')
  })

  it('rejects a waiver without a reason', () => {
    const result = checkCoverage({
      config,
      changedFiles: [{ path: 'src/a.ts', status: 'D' }],
      commitMessages: ['fix: x\n\nchangelog: none —'],
    })
    expect(result).toEqual({ _tag: 'Missing', sources: ['src/a.ts'] })
  })

  it('explains both remedies', () => {
    const text = describeMissingCoverage({ config, sources: ['src/a.ts'] })
    expect(text).toContain('.changelog/YYYY-MM-DD-slug.ts')
    expect(text).toContain('changelog: none — <reason>')
  })
})
