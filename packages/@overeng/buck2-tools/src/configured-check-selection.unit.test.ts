import { describe, expect, it } from 'vitest'

import {
  affectedPackagePaths, buildTargetsFor, selectConfiguredChecks,
  type ConfiguredCheckSnapshot,
} from './buck-watch.ts'

const first = 'root//app:check (root//platform:linux#1111)'
const second = 'root//other:check (root//platform:linux#1111)'
const base: ConfiguredCheckSnapshot = {
  revision: 'a'.repeat(40), configuration: 'linux-toolchain-1', complete: true,
  checks: { [first]: 'graph-one', [second]: 'graph-two' },
  affectedTargets: [], ownedPaths: [],
}

const alternate = 'root//app:check (root//platform:linux#2222)'
const candidate = { ...base, revision: 'b'.repeat(40) }

describe('configured check selection', () => {
  it('selects configured reverse dependencies of a changed file', () => {
    const result = selectConfiguredChecks({ base, candidate: {
      ...candidate, affectedTargets: [first], ownedPaths: ['app/src/main.ts'],
    }, changedPaths: ['app/src/main.ts'] })
    expect(result.mode).toBe('affected')
    expect(result.targets).toEqual([first])
  })

  it('retains old ownership for deleted files and reverse dependents', () => {
    const result = selectConfiguredChecks({ base: {
      ...base, affectedTargets: [first], ownedPaths: ['app/src/deleted.ts'],
    }, candidate, changedPaths: ['app/src/deleted.ts'] })
    expect(result.targets).toEqual([first])
  })

  it('selects changed configured dependency graphs without a direct owner', () => {
    const result = selectConfiguredChecks({ base, candidate: {
      ...candidate, checks: { ...candidate.checks, [first]: 'new-dependency' },
      ownedPaths: ['app/package.json'],
    }, changedPaths: ['app/package.json'] })
    expect(result.mode).toBe('affected')
    expect(result.targets).toEqual([first])
  })

  it('invalidates the full set when the execution configuration changes', () => {
    const result = selectConfiguredChecks({ base, candidate: {
      ...candidate, configuration: 'linux-toolchain-2',
    }, changedPaths: [] })
    expect(result.mode).toBe('full')
    expect(result.targets).toEqual(result.fullTargets)
    expect(result.reasons).toContain('configuration-changed')
  })

  it.each(['flake.lock', '.buckconfig', 'pkg/BUCK', 'rules/check.bzl', 'toolchains/sdk.json'])(
    'runs full for undecidable global change %s', (path) => {
      const result = selectConfiguredChecks({ base, candidate, changedPaths: [path] })
      expect(result.mode).toBe('full')
      expect(result.targets).toEqual(result.fullTargets)
    },
  )

  it('does not interpret a missing or failed graph as empty coverage', () => {
    const result = selectConfiguredChecks({ base: { ...base, complete: false },
      candidate, changedPaths: [] })
    expect(result.mode).toBe('full')
    expect(result.reasons).toContain('incomplete-configured-query')
  })

  it('falls back for unknown ownership and changed required inventory', () => {
    const result = selectConfiguredChecks({ base, candidate: {
      ...candidate, checks: { [first]: 'graph-one' },
    }, changedPaths: ['unknown/input'] })
    expect(result.mode).toBe('full')
    expect(result.reasons).toContain('unknown-ownership:unknown/input')
    expect(result.removedTargets).toEqual([second])
  })

  it('selects nothing for an empty diff and identical configured graphs', () => {
    const result = selectConfiguredChecks({ base, candidate, changedPaths: [] })
    expect(result.mode).toBe('affected')
    expect(result.targets).toEqual([])
  })

  it('reports removal of a configured instance even when its label remains', () => {
    const result = selectConfiguredChecks({ base: {
      ...base, checks: { ...base.checks, [alternate]: 'alternate-graph' },
    }, candidate, changedPaths: [] })
    expect(result.mode).toBe('full')
    expect(result.reasons).toContain('required-inventory-changed')
    expect(result.removedTargets).toEqual([alternate])
  })

  it('reuses existing reverse workspace package closure and product selection', () => {
    const plan = { globalPaths: [], packages: [
      { packagePath: 'packages/lib', sourceRoots: ['src'], workspaceDependencies: [],
        targets: { packageTree: 'root//packages/lib:tree' } },
      { packagePath: 'packages/app', sourceRoots: ['src'], workspaceDependencies: ['packages/lib'],
        targets: { packageTree: 'root//packages/app:tree' } },
    ] }
    const packagePaths = affectedPackagePaths({ plan, changedPaths: ['packages/lib/src/a.ts'] })
    expect(packagePaths).toEqual(['packages/app', 'packages/lib'])
    expect(buildTargetsFor({ plan, packagePaths })).toEqual([
      'root//packages/app:tree', 'root//packages/lib:tree',
    ])
  })
})
