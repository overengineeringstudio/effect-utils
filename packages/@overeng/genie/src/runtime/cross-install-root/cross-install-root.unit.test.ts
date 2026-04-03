import { describe, expect, it } from 'vitest'

import { detectVersionDivergence, parseResolvedVersionsFromLockfile } from './mod.ts'

const makeLockfileYaml = (packages: string[]) => {
  const lines = ["lockfileVersion: '9.0'", '', 'packages:', '']
  for (const spec of packages) {
    const needsQuote = spec.startsWith('@') === true
    lines.push(needsQuote ? `  '${spec}':` : `  ${spec}:`)
    lines.push('    resolution: {integrity: sha512-fake}')
    lines.push('')
  }
  lines.push('snapshots:', '')
  return lines.join('\n')
}

describe('parseResolvedVersionsFromLockfile', () => {
  it('parses scoped packages', () => {
    const yaml = makeLockfileYaml(['@effect/platform@0.96.0', 'effect@3.21.0'])
    const result = parseResolvedVersionsFromLockfile(yaml)
    expect(result.get('@effect/platform')).toBe('0.96.0')
    expect(result.get('effect')).toBe('3.21.0')
  })

  it('parses unscoped packages', () => {
    const yaml = makeLockfileYaml(['react@19.2.3', 'react-dom@19.2.3'])
    const result = parseResolvedVersionsFromLockfile(yaml)
    expect(result.get('react')).toBe('19.2.3')
    expect(result.get('react-dom')).toBe('19.2.3')
  })

  it('skips resolution-specific entries with parentheses', () => {
    const lines = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  'effect@3.21.0':",
      '    resolution: {integrity: sha512-first}',
      '',
      "  '@effect/platform@0.96.0(effect@3.21.0)':",
      '    dependencies:',
      '      effect: 3.21.0',
      '',
    ].join('\n')
    const result = parseResolvedVersionsFromLockfile(lines)
    expect(result.size).toBe(1)
    expect(result.get('effect')).toBe('3.21.0')
  })

  it('deduplicates — keeps first entry', () => {
    const lines = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  'effect@3.21.0':",
      '    resolution: {integrity: sha512-first}',
      '',
      "  'effect@3.19.19':",
      '    resolution: {integrity: sha512-second}',
      '',
    ].join('\n')
    const result = parseResolvedVersionsFromLockfile(lines)
    expect(result.get('effect')).toBe('3.21.0')
  })

  it('stops at snapshots section', () => {
    const lines = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  'effect@3.21.0':",
      '    resolution: {integrity: sha512-fake}',
      '',
      'snapshots:',
      '',
      "  'other@1.0.0':",
      '    resolution: {integrity: sha512-fake}',
      '',
    ].join('\n')
    const result = parseResolvedVersionsFromLockfile(lines)
    expect(result.size).toBe(1)
    expect(result.has('other')).toBe(false)
  })

  it('handles workspace lockfiles with multiple packages sections', () => {
    const lines = [
      "lockfileVersion: '9.0'",
      '',
      'importers:',
      '',
      '  .:',
      '    dependencies: {}',
      '',
      'packages:',
      '',
      "  'pnpm@11.0.0':",
      '    resolution: {integrity: sha512-fake}',
      '',
      'snapshots:',
      '',
      "  'pnpm@11.0.0':",
      '    {}',
      '',
      'packages:',
      '',
      "  'effect@3.21.0':",
      '    resolution: {integrity: sha512-fake}',
      '',
      "  'react@19.2.3':",
      '    resolution: {integrity: sha512-fake}',
      '',
    ].join('\n')
    const result = parseResolvedVersionsFromLockfile(lines)
    expect(result.get('pnpm')).toBe('11.0.0')
    expect(result.get('effect')).toBe('3.21.0')
    expect(result.get('react')).toBe('19.2.3')
  })

  it('returns empty map for empty packages section', () => {
    const yaml = makeLockfileYaml([])
    const result = parseResolvedVersionsFromLockfile(yaml)
    expect(result.size).toBe(0)
  })
})

describe('detectVersionDivergence', () => {
  it('returns [] when all roots agree', () => {
    const versionsByRoot = new Map([
      ['dotfiles', new Map([['effect', '3.21.0']])],
      ['effect-utils', new Map([['effect', '3.21.0']])],
    ])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect'],
    })
    expect(issues).toEqual([])
  })

  it('returns [] when only one root exists', () => {
    const versionsByRoot = new Map([['dotfiles', new Map([['effect', '3.21.0']])]])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect'],
    })
    expect(issues).toEqual([])
  })

  it('returns error when versions diverge', () => {
    const versionsByRoot = new Map([
      ['dotfiles', new Map([['effect', '3.21.0']])],
      ['effect-utils', new Map([['effect', '3.19.19']])],
    ])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect'],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({
      severity: 'error',
      dependency: 'effect',
      rule: 'cross-install-root-version-divergence',
    })
    expect(issues[0]!.message).toContain('dotfiles → 3.21.0')
    expect(issues[0]!.message).toContain('effect-utils → 3.19.19')
  })

  it('returns separate errors for each diverging package', () => {
    const versionsByRoot = new Map([
      [
        'dotfiles',
        new Map([
          ['effect', '3.21.0'],
          ['react', '19.2.3'],
        ]),
      ],
      [
        'effect-utils',
        new Map([
          ['effect', '3.19.19'],
          ['react', '18.3.1'],
        ]),
      ],
    ])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect', 'react'],
    })
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.dependency)).toEqual(['effect', 'react'])
  })

  it('only checks packages listed in identityCriticalPackages', () => {
    const versionsByRoot = new Map([
      [
        'dotfiles',
        new Map([
          ['effect', '3.21.0'],
          ['lodash', '4.17.21'],
        ]),
      ],
      [
        'effect-utils',
        new Map([
          ['effect', '3.21.0'],
          ['lodash', '4.17.20'],
        ]),
      ],
    ])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect'],
    })
    expect(issues).toEqual([])
  })

  it('skips packages not present in a given root', () => {
    const versionsByRoot = new Map([
      ['dotfiles', new Map([['effect', '3.21.0']])],
      ['effect-utils', new Map<string, string>()],
    ])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect'],
    })
    expect(issues).toEqual([])
  })

  it('works with more than two install roots', () => {
    const versionsByRoot = new Map([
      ['dotfiles', new Map([['effect', '3.21.0']])],
      ['effect-utils', new Map([['effect', '3.21.0']])],
      ['private-shared', new Map([['effect', '3.19.19']])],
    ])
    const issues = detectVersionDivergence({
      versionsByRoot,
      identityCriticalPackages: ['effect'],
    })
    expect(issues).toHaveLength(1)
    expect(issues[0]!.message).toContain('private-shared → 3.19.19')
  })
})
