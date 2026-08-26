import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  isRootTsconfigCheckProject,
  isRootTsconfigEmitProject,
  rootTsconfigProjects,
  type RootTsconfigProject,
} from '../tsconfig-projects.ts'
import {
  conservativeFullImporterRoots,
  decodePnpmLockfile,
  discoverPackageSources,
  materializerPolicyDigest,
  relevantPackageNamesForPlan,
  workspaceLabelsFor,
} from '../../packages/@overeng/tui-core/buck2/target.ts'

const temporaryRoots: string[] = []

const temporaryPackage = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'effect-utils-tui-core-census-'))
  temporaryRoots.push(root)
  mkdirSync(path.join(root, 'src'), { recursive: true })
  mkdirSync(path.join(root, 'test'), { recursive: true })
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('tui-core Buck projection policy', () => {
  it('partitions only the explicitly Buck-owned project from root check and emit graphs', () => {
    const rootPaths = rootTsconfigProjects.map((project) => project.path)
    const checkPaths = rootTsconfigProjects
      .filter(isRootTsconfigCheckProject)
      .map((project) => project.path)
    const emitPaths = rootTsconfigProjects
      .filter(isRootTsconfigEmitProject)
      .map((project) => project.path)
    const transferredProject: RootTsconfigProject | undefined = rootTsconfigProjects.find(
      (project) => project.path === 'packages/@overeng/tui-core',
    )

    // Build mode counts the solution itself in addition to its direct references.
    expect(rootPaths.length + 1).toBe(39)
    expect(checkPaths.length + 1).toBe(38)
    expect(emitPaths.length + 1).toBe(38)
    expect(rootPaths.filter((path) => checkPaths.includes(path) === false)).toEqual([
      'packages/@overeng/tui-core',
    ])
    expect(rootPaths.filter((path) => emitPaths.includes(path) === false)).toEqual([
      'packages/@overeng/tui-core',
    ])
    expect(transferredProject?.buck2Authority).toEqual({
      _tag: 'Buck2TypeScriptAuthority',
      typecheckTarget: '//packages/@overeng/tui-core:typecheck',
      emitTarget: '//packages/@overeng/tui-core:dist',
    })
  })

  it('keeps all five former dependents detached from the Buck-owned project reference', () => {
    const dependentPaths = [
      'packages/@overeng/genie',
      'packages/@overeng/megarepo',
      'packages/@overeng/notion-cli',
      'packages/@overeng/tui-react',
      'packages/@overeng/tui-stories',
    ] as const

    for (const dependentPath of dependentPaths) {
      const dependent = rootTsconfigProjects.find((project) => project.path === dependentPath)
      expect(dependent, dependentPath).toBeDefined()
      expect(dependent?.tsconfig.data.references ?? [], dependentPath).not.toContainEqual({
        path: '../tui-core',
      })
    }
  })

  it('includes newly-added nested TypeScript sources in deterministic order', () => {
    const root = temporaryPackage()
    mkdirSync(path.join(root, 'src', 'nested'))
    writeFileSync(path.join(root, 'src', 'z.ts'), '')
    writeFileSync(path.join(root, 'src', 'nested', 'a.tsx'), '')
    writeFileSync(path.join(root, 'src', 'notes.md'), 'not a TypeScript input')
    writeFileSync(path.join(root, 'test', 'renderer.test.ts'), '')

    expect(discoverPackageSources(root)).toEqual([
      'src/nested/a.tsx',
      'src/z.ts',
      'test/renderer.test.ts',
    ])

    writeFileSync(path.join(root, 'test', 'new.test.ts'), '')
    expect(discoverPackageSources(root)).toContain('test/new.test.ts')
  })

  it('refuses symlinked source inputs instead of escaping the declared package root', () => {
    const root = temporaryPackage()
    writeFileSync(path.join(root, 'src', 'real.ts'), '')
    symlinkSync(path.join(root, 'src', 'real.ts'), path.join(root, 'test', 'linked.ts'))

    expect(() => discoverPackageSources(root)).toThrow('Package source census refuses symlink')
  })

  it('uses every importer field as an explicitly-reasoned root in stable order', () => {
    expect(
      conservativeFullImporterRoots({
        optionalDependencies: { optional: '3.0.0' },
        dependencies: { zed: '1.0.0', alpha: '2.0.0' },
        devDependencies: { alpha: '2.0.0' },
      }),
    ).toEqual([
      { alias: 'alpha', field: 'dependencies', reason: 'conservative-full-importer:dependencies' },
      {
        alias: 'alpha',
        field: 'devDependencies',
        reason: 'conservative-full-importer:devDependencies',
      },
      {
        alias: 'optional',
        field: 'optionalDependencies',
        reason: 'conservative-full-importer:optionalDependencies',
      },
      { alias: 'zed', field: 'dependencies', reason: 'conservative-full-importer:dependencies' },
    ])
  })

  it('emits deterministic safe labels and rejects path traversal', () => {
    expect(
      workspaceLabelsFor({ importers: { 'packages/z': {}, '.': {}, 'packages/a': {} } }),
    ).toEqual({
      '.': '//:workspace_package',
      'packages/a': '//packages/a:workspace_package',
      'packages/z': '//packages/z:workspace_package',
    })
    expect(() => workspaceLabelsFor({ importers: { '../private': {} } })).toThrow(
      'Unsafe pnpm importer id',
    )
  })

  it('hashes selected materialization policy without unrelated workspace keys', () => {
    const policy = {
      allowBuilds: { esbuild: false, sharp: false },
      ignoreScripts: true,
      injectWorkspacePackages: true,
      packageImportMethod: 'auto',
      sideEffectsCache: false,
      strictStorePkgContentCheck: true,
      verifyStoreIntegrity: true,
    }
    const relevantPackageNames = relevantPackageNamesForPlan({
      packages: [
        { depPath: 'vitest@4.1.9', packageName: 'vitest' },
        { depPath: 'esbuild@0.27.7', packageName: 'esbuild' },
        { depPath: '@types/node@26.0.0', packageName: '@types/node' },
      ],
    })
    expect(relevantPackageNames).toEqual(['@types/node', 'esbuild', 'vitest'])
    const digest = (workspaceValue: unknown) =>
      materializerPolicyDigest({ workspaceValue, relevantPackageNames })

    expect(digest({ ...policy, catalog: { effect: '3.0.0' } })).toBe(
      digest({ ...policy, catalog: { effect: '4.0.0' } }),
    )
    expect(digest({ ...policy, allowBuilds: { ...policy.allowBuilds, sharp: true } })).toBe(
      digest(policy),
    )
    expect(digest({ ...policy, allowBuilds: { ...policy.allowBuilds, esbuild: true } })).not.toBe(
      digest(policy),
    )
    expect(digest({ ...policy, ignoreScripts: false })).not.toBe(digest(policy))
  })

  it('rejects malformed parsed lockfile boundaries', () => {
    expect(() => decodePnpmLockfile({ lockfileVersion: '9.0', importers: {} })).toThrow(
      'pnpm-lock.yaml packages must be an object',
    )
  })
})
