import { describe, expect, it } from 'vitest'

import { parsePeerDepsFromLockfile, validateCatalogPeerDeps } from './mod.ts'

const makeLockfileYaml = (
  packages: Record<string, { peerDependencies?: Record<string, string> }>,
) => {
  const lines = ["lockfileVersion: '9.0'", '', 'packages:', '']
  for (const [spec, data] of Object.entries(packages)) {
    lines.push(`  '${spec}':`)
    lines.push(`    resolution: {integrity: sha512-fake}`)
    if (data.peerDependencies !== undefined) {
      lines.push('    peerDependencies:')
      for (const [name, range] of Object.entries(data.peerDependencies)) {
        /* YAML quotes scoped package names */
        const key = name.startsWith('@') === true ? `'${name}'` : name
        lines.push(`      ${key}: ${range}`)
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

describe('parsePeerDepsFromLockfile', () => {
  it('parses simple entries', () => {
    const yaml = makeLockfileYaml({
      'effect@3.21.0': {},
      '@effect/platform@0.96.0': {
        peerDependencies: { effect: '^3.21.0' },
      },
    })
    const result = parsePeerDepsFromLockfile(yaml)
    expect(result.size).toBe(1)
    expect(result.get('@effect/platform')).toEqual({
      version: '0.96.0',
      peerDependencies: { effect: '^3.21.0' },
    })
  })

  it('handles scoped packages with YAML-quoted keys', () => {
    const yaml = makeLockfileYaml({
      '@effect-atom/atom@0.5.3': {
        peerDependencies: {
          '@effect/experimental': '^0.58.0',
          effect: '^3.19.15',
        },
      },
    })
    const result = parsePeerDepsFromLockfile(yaml)
    const entry = result.get('@effect-atom/atom')
    expect(entry).toBeDefined()
    expect(entry!.peerDependencies['@effect/experimental']).toBe('^0.58.0')
    expect(entry!.peerDependencies['effect']).toBe('^3.19.15')
  })

  it('ignores packages without peer deps', () => {
    const yaml = makeLockfileYaml({
      'effect@3.21.0': {},
    })
    expect(parsePeerDepsFromLockfile(yaml).size).toBe(0)
  })

  it('deduplicates — keeps first (metadata) entry', () => {
    const lines = [
      "lockfileVersion: '9.0'",
      '',
      'packages:',
      '',
      "  '@pkg/a@1.0.0':",
      '    resolution: {integrity: sha512-first}',
      '    peerDependencies:',
      '      b: ^2.0.0',
      '',
      "  '@pkg/a@1.0.0(b@2.0.0)':",
      '    dependencies:',
      '      b: 2.0.0',
      '',
    ].join('\n')
    const result = parsePeerDepsFromLockfile(lines)
    expect(result.size).toBe(1)
    expect(result.get('@pkg/a')!.peerDependencies).toEqual({ b: '^2.0.0' })
  })
})

describe('validateCatalogPeerDeps', () => {
  it('returns no issues when all peers are satisfied', () => {
    const lockfile = makeLockfileYaml({
      '@effect/platform@0.96.0': {
        peerDependencies: { effect: '^3.21.0' },
      },
    })
    const issues = validateCatalogPeerDeps({
      catalog: { '@effect/platform': '0.96.0', effect: '3.21.0' },
      lockfileContent: lockfile,
    })
    expect(issues).toEqual([])
  })

  it('reports error for unsatisfied pre-1.0 caret peer range', () => {
    const lockfile = makeLockfileYaml({
      '@effect-atom/atom@0.5.3': {
        peerDependencies: {
          '@effect/experimental': '^0.58.0',
          '@effect/platform': '^0.94.2',
          '@effect/rpc': '^0.73.0',
          effect: '^3.19.15',
        },
      },
    })
    const issues = validateCatalogPeerDeps({
      catalog: {
        '@effect-atom/atom': '0.5.3',
        '@effect/experimental': '0.60.0',
        '@effect/platform': '0.96.0',
        '@effect/rpc': '0.75.0',
        effect: '3.21.0',
      },
      lockfileContent: lockfile,
    })
    const errors = issues.filter((i) => i.severity === 'error')
    expect(errors).toHaveLength(3)
    expect(errors.map((e) => e.dependency).sort()).toEqual([
      '@effect/experimental',
      '@effect/platform',
      '@effect/rpc',
    ])
  })

  it('downgrades conflict to warning when covered by peerDependencyRules', () => {
    const lockfile = makeLockfileYaml({
      '@effect-atom/atom@0.5.3': {
        peerDependencies: { '@effect/experimental': '^0.58.0' },
      },
    })
    const issues = validateCatalogPeerDeps({
      catalog: { '@effect-atom/atom': '0.5.3', '@effect/experimental': '0.60.0' },
      lockfileContent: lockfile,
      peerDependencyRules: {
        allowedVersions: { '@effect/experimental': '>=0.58.0' },
      },
    })
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(issues.filter((i) => i.rule === 'catalog-peer-dep-conflict-suppressed')).toHaveLength(1)
  })

  it('warns about stale peerDependencyRules entries', () => {
    const lockfile = makeLockfileYaml({
      '@effect/platform@0.96.0': {
        peerDependencies: { effect: '^3.21.0' },
      },
    })
    const issues = validateCatalogPeerDeps({
      catalog: { '@effect/platform': '0.96.0', effect: '3.21.0' },
      lockfileContent: lockfile,
      peerDependencyRules: {
        allowedVersions: { '@effect/experimental': '>=0.58.0' },
      },
    })
    const stale = issues.filter((i) => i.rule === 'catalog-peer-dep-stale-override')
    expect(stale).toHaveLength(1)
    expect(stale[0]!.dependency).toBe('@effect/experimental')
  })

  it('skips catalog entries not in lockfile', () => {
    const lockfile = makeLockfileYaml({})
    const issues = validateCatalogPeerDeps({
      catalog: { effect: '3.21.0', '@effect/platform': '0.96.0' },
      lockfileContent: lockfile,
    })
    expect(issues).toEqual([])
  })

  it('skips peer deps not in catalog', () => {
    const lockfile = makeLockfileYaml({
      '@effect/experimental@0.60.0': {
        peerDependencies: { lmdb: '^3', effect: '^3.21.0' },
      },
    })
    const issues = validateCatalogPeerDeps({
      catalog: { '@effect/experimental': '0.60.0', effect: '3.21.0' },
      lockfileContent: lockfile,
    })
    expect(issues).toEqual([])
  })
})
