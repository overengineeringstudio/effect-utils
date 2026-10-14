import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { packageJson, workspaceClosureReference, type GenieContext } from '../mod.ts'
import { defineCatalog } from '../package-json/catalog.ts'
import type { NamedWorkspacePackageLike, WorkspacePackage } from '../package-json/mod.ts'
import {
  pnpmWorkspaceYaml,
  projectPnpmPackageClosure,
  projectPnpmSourceInputs,
  projectPrivateProductTarballs,
} from './mod.ts'

const mockGenieContext: GenieContext = {
  location: '.',
  cwd: '/workspace',
}

const createTempRepo = (...memberPaths: string[]) => {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-workspace-'))
  fs.mkdirSync(path.join(repoRoot, '.git'))

  return {
    repoRoot,
    repoName: path.basename(repoRoot),
    memberDirs: Object.fromEntries(
      memberPaths.map((memberPath) => {
        const memberDir = path.join(repoRoot, memberPath)
        fs.mkdirSync(memberDir, { recursive: true })
        return [memberPath, memberDir]
      }),
    ) as Record<string, string>,
  }
}

const workspace = ({
  repoName,
  memberPath,
  pnpmPackageClosure,
}: {
  repoName: string
  memberPath: string
  pnpmPackageClosure?: {
    extraMemberPaths?: readonly string[]
  }
}) => ({
  repoName,
  memberPath,
  ...(pnpmPackageClosure !== undefined ? { pnpmPackageClosure } : {}),
})

describe('projected source peer rules', () => {
  // Same a@0.1.0 / b -> a@^0.1.0 graph as the pnpm file-peer repro.
  const fixture = ({ version = '0.1.0', range = '^0.1.0', includePeer = true } = {}) => {
    const a: NamedWorkspacePackageLike = {
      data: { name: 'a', version },
      meta: { workspace: { repoName: 'library', memberPath: 'a', deps: [] } },
    }
    const b: NamedWorkspacePackageLike = {
      data: {
        name: 'b',
        version: '0.1.0',
        peerDependencies: { a: range },
        peerDependenciesMeta: { a: { optional: true } },
      },
      meta: {
        workspace: {
          repoName: 'library',
          memberPath: 'b',
          deps: includePeer === true ? [a] : [],
        },
      },
    }
    return { a, b }
  }

  it('validates satisfied peers and emits identity-pinned edge rules alongside overrides', () => {
    const { b } = fixture()
    const projection = projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' })
    expect(projection).toEqual({
      sourceInputPaths: ['repos/library/a', 'repos/library/b'],
      overrides: {
        a: 'file:.devenv/pnpm-source-inputs/current/repos/library/a',
        b: 'file:.devenv/pnpm-source-inputs/current/repos/library/b',
      },
      peerDependencyRules: {
        allowedVersions: { 'b>a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a' },
      },
    })
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [],
      repoName: 'consumer',
      strictPeerDependencies: true,
      overrides: projection.overrides,
      peerDependencyRules: projection.peerDependencyRules,
    })
    const yaml = workspaceFile.stringify(mockGenieContext)
    expect(yaml).toContain('strictPeerDependencies: true')
    expect(yaml).toContain(
      "overrides:\n  a: 'file:.devenv/pnpm-source-inputs/current/repos/library/a'\n  b: 'file:.devenv/pnpm-source-inputs/current/repos/library/b'",
    )
    expect(yaml).toContain(
      "peerDependencyRules:\n  allowedVersions:\n    b>a: 'file:.devenv/pnpm-source-inputs/current/repos/library/a'",
    )
    expect(yaml).not.toContain('allowAny')
    expect(yaml).not.toContain('ignoreMissing')
  })

  it('fails closed on an unsatisfied projected peer range', () => {
    const { b } = fixture({ range: '^0.2.0' })
    expect(() => projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' })).toThrow(
      'b peer a ^0.2.0 vs projected 0.1.0',
    )
  })

  it('fails closed with the peer edge when the target version is missing', () => {
    const { a, b } = fixture()
    delete a.data.version
    expect(() => projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' })).toThrow(
      'b peer a ^0.1.0 vs projected (missing version)',
    )
  })

  it('validates a required peer also present in dependencies', () => {
    const { b } = fixture()
    delete b.data.peerDependenciesMeta
    b.data.dependencies = { a: 'workspace:^' }
    expect(
      projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({
      allowedVersions: { 'b>a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a' },
    })
  })

  it('scopes the allowance to scoped dependent and peer names', () => {
    const { a, b } = fixture()
    a.data.name = '@test/a'
    b.data.name = '@test/b'
    b.data.peerDependencies = { '@test/a': '^0.1.0' }
    b.data.peerDependenciesMeta = { '@test/a': { optional: true } }
    expect(
      projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({
      allowedVersions: {
        '@test/b>@test/a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a',
      },
    })
  })

  it('emits separate sorted allowances for multiple dependents of the same peer', () => {
    const { a, b } = fixture()
    const c: NamedWorkspacePackageLike = {
      data: { name: 'c', version: '0.1.0', peerDependencies: { a: '~0.1.0' } },
      meta: { workspace: { repoName: 'library', memberPath: 'c', deps: [a] } },
    }
    expect(
      projectPnpmSourceInputs({ packages: [c, b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({
      allowedVersions: {
        'b>a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a',
        'c>a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a',
      },
    })
  })

  it.each([true, false])(
    'prefers full manifests over closure references independent of order (reference first: %s)',
    (referenceFirst) => {
      const { a, b } = fixture()
      const reference = workspaceClosureReference(b)
      const packages = referenceFirst === true ? [reference, b, a] : [b, a, reference]
      expect(projectPnpmSourceInputs({ packages, repoName: 'consumer' })).toEqual(
        projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }),
      )
      a.data.version = '0.2.0'
      expect(() => projectPnpmSourceInputs({ packages, repoName: 'consumer' })).toThrow(
        'b peer a ^0.1.0 vs projected 0.2.0',
      )
    },
  )

  it.each([true, false])(
    'fails closed if a projected dependent only has a closure reference (reference first: %s)',
    (referenceFirst) => {
      const { a, b } = fixture()
      const reference = workspaceClosureReference(b)
      const packages = referenceFirst === true ? [reference, a] : [a, reference]
      expect(() => projectPnpmSourceInputs({ packages, repoName: 'consumer' })).toThrow(
        'Projected package b requires a full manifest to validate peer dependencies',
      )
    },
  )

  it.each([
    '~0.1.0',
    '0.1.0',
    '>=0.1.0',
    '>=0.1.0 <0.2.0',
    '0.1.x',
    '0.x.x',
    '0.x',
    '^0.2.0 || ~0.1.0',
  ])('validates supported stable range grammar: %s', (range) => {
    const { b } = fixture({ range })
    expect(
      projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({
      allowedVersions: { 'b>a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a' },
    })
  })

  it('rechecks the peer contract when the projected version changes at the same file path', () => {
    const { a, b } = fixture()
    expect(
      projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({
      allowedVersions: { 'b>a': 'file:.devenv/pnpm-source-inputs/current/repos/library/a' },
    })
    a.data.version = '0.2.0'
    expect(() => projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' })).toThrow(
      'b peer a ^0.1.0 vs projected 0.2.0',
    )
  })

  it('emits no rule for an absent optional peer', () => {
    const { b } = fixture({ includePeer: false })
    expect(
      projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({ allowedVersions: {} })
  })

  it('emits no rule for a registry peer', () => {
    const { b } = fixture()
    b.data.peerDependencies = { registry: '^1.0.0' }
    expect(
      projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' }).peerDependencyRules,
    ).toEqual({ allowedVersions: {} })
  })

  it.each([
    { version: '0.1.0-rc.1', range: '^0.1.0' },
    { version: '0.1.0', range: '^0.1.0-rc.1' },
    { version: '0.1.0', range: '<=0.2.0' },
    { version: '0.1.0', range: 'workspace:^0.1.0' },
    { version: '0.1.0', range: 'file:../a' },
    { version: '0.1.0', range: '0.1.0 - 0.2.0' },
    { version: '0.1.0', range: '0.1.x.x' },
    { version: '0.1.0', range: '^0.1.0 || 1.2.x.x' },
    { version: '0.1.0', range: '1.2.x.x || ^0.1.0' },
    { version: '0.1.0', range: '^0.1.0 || file:../a' },
    { version: '0.1.0+build', range: '^0.1.0' },
    { version: '0.1.0', range: '^0.1.0 || >=9007199254740992.0.0' },
  ])('rejects semver syntax the shared checker cannot fully evaluate: %j', (input) => {
    const { b } = fixture(input)
    expect(() => projectPnpmSourceInputs({ packages: [b], repoName: 'consumer' })).toThrow(
      `b peer a ${input.range} vs projected ${input.version}: unsupported semver version or range`,
    )
  })
})

describe('metadata-based workspace projections', () => {
  const repo = createTempRepo('packages/utils', 'packages/app')
  const catalog = defineCatalog({})
  const utilsComposition = catalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/utils',
    }),
  })
  const utils = packageJson(
    {
      name: '@test/utils',
      version: '1.0.0',
    },
    utilsComposition,
  )
  const appComposition = catalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/app',
      pnpmPackageClosure: {
        extraMemberPaths: ['packages/examples/basic'],
      },
    }),
    dependencies: {
      workspace: [utils],
    },
  })
  const app = packageJson(
    {
      name: '@test/app',
      version: '1.0.0',
    },
    appComposition,
  )
  const exampleComposition = catalog.compose({
    workspace: workspace({
      repoName: repo.repoName,
      memberPath: 'packages/examples/basic',
    }),
  })
  const example = packageJson(
    {
      name: '@test/example-basic',
      version: '1.0.0',
    },
    exampleComposition,
  )

  it('projects package-closure workspace members from package metadata', () => {
    const workspaceProjection = projectPnpmPackageClosure({
      pkg: app,
    })

    expect(workspaceProjection.workspaceClosureDirs).toEqual([
      'packages/app',
      'packages/examples/basic',
      'packages/utils',
    ])
    expect(workspaceProjection.packageRelativeMemberPaths).toEqual([
      '.',
      '../examples/basic',
      '../utils',
    ])
  })

  it('projects root workspace members recursively from package metadata', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app, example],
      repoName: repo.repoName,
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual([
      'packages/app',
      'packages/examples/basic',
      'packages/utils',
    ])
  })

  it('stops root workspace projection at foreign repo boundaries', () => {
    const foreignRepo = createTempRepo('packages/shared')
    const foreignShared = packageJson(
      {
        name: '@foreign/shared',
        version: '1.0.0',
      },
      catalog.compose({
        workspace: workspace({
          repoName: foreignRepo.repoName,
          memberPath: 'packages/shared',
        }),
      }),
    )
    const crossRepoApp = packageJson(
      {
        name: '@test/cross-repo-app',
        version: '1.0.0',
      },
      catalog.compose({
        workspace: workspace({
          repoName: repo.repoName,
          memberPath: 'packages/app',
        }),
        dependencies: {
          workspace: [utils, foreignShared],
        },
      }),
    )

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [crossRepoApp, utils, foreignShared],
      repoName: repo.repoName,
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual(['packages/app', 'packages/utils'])

    expect(projectPnpmSourceInputs({ packages: [crossRepoApp], repoName: repo.repoName })).toEqual({
      sourceInputPaths: [`repos/${foreignRepo.repoName}/packages/shared`],
      overrides: {
        '@foreign/shared': `file:.devenv/pnpm-source-inputs/current/repos/${foreignRepo.repoName}/packages/shared`,
      },
      peerDependencyRules: { allowedVersions: {} },
    })
  })

  it('includes extraMembers in root workspace projection', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app, example],
      repoName: repo.repoName,
      extraMembers: ['examples/*'],
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual([
      'examples/*',
      'packages/app',
      'packages/examples/basic',
      'packages/utils',
    ])
  })

  it('serializes top-level storeDir', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      storeDir: '.pnpm-store',
    })

    expect(workspaceFile.stringify(mockGenieContext)).toContain('storeDir: .pnpm-store')
  })

  it.each([true, false])('serializes enableGlobalVirtualStore: %s', (enableGlobalVirtualStore) => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      nodeLinker: 'isolated',
      enableGlobalVirtualStore,
    })

    expect(workspaceFile.stringify(mockGenieContext)).toContain(
      `enableGlobalVirtualStore: ${enableGlobalVirtualStore}`,
    )
  })

  it('omits enableGlobalVirtualStore when not configured', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      nodeLinker: 'isolated',
    })

    expect(workspaceFile.stringify(mockGenieContext)).not.toContain('enableGlobalVirtualStore:')
  })

  it('serializes hoistingLimits for hoisted pnpm workspaces', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      nodeLinker: 'hoisted',
      hoistingLimits: 'workspaces',
    })

    expect(workspaceFile.stringify(mockGenieContext)).toContain('hoistingLimits: workspaces')
  })

  it('projects workspace root workspaces from package metadata', () => {
    const workspaceRoot = packageJson.aggregateFromPackages({
      packages: [app],
      name: 'workspace-root',
      repoName: repo.repoName,
    })

    expect(workspaceRoot.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })

  it('excludes direct foreign seeds from workspace root workspaces', () => {
    const foreignRepo = createTempRepo('packages/shared')
    const foreignShared = packageJson(
      {
        name: '@foreign/shared',
        version: '1.0.0',
      },
      catalog.compose({
        workspace: workspace({
          repoName: foreignRepo.repoName,
          memberPath: 'packages/shared',
        }),
      }),
    )

    const workspaceRoot = packageJson.aggregateFromPackages({
      packages: [app, utils, foreignShared],
      name: 'workspace-root',
      repoName: repo.repoName,
    })

    expect(workspaceRoot.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })
})

describe('private product tarballs', () => {
  const sha256 = 'b2533339ab5d0a41a36ae71e266e891acd551f9cf054fcd49bfcfdd3d421dca5'

  it('pins each product to a root-relative, digest-named staged tarball', () => {
    expect(
      projectPrivateProductTarballs({
        products: [
          { name: '@overeng/meters', version: '0.1.0', sha256: 'a'.repeat(64) },
          { name: '@overeng/geist-design-system', version: '0.1.0', sha256 },
        ],
      }).overrides,
    ).toEqual({
      '@overeng/geist-design-system': `file:.devenv/pnpm-product-tarballs/overeng-geist-design-system-0.1.0-${sha256}.tgz`,
      '@overeng/meters': `file:.devenv/pnpm-product-tarballs/overeng-meters-0.1.0-${'a'.repeat(64)}.tgz`,
    })
  })

  it('rejects rows that cannot name one immutable staged file', () => {
    const row = { name: '@overeng/meters', version: '0.1.0', sha256 }
    for (const [products, message] of [
      [[row, row], /listed more than once/],
      [[{ ...row, name: 'meters' }], /scoped npm package name/],
      [[{ ...row, version: '../0.1.0' }], /invalid version/],
      [[{ ...row, sha256: sha256.toUpperCase() }], /lowercase hexadecimal/],
    ] as const) {
      expect(() => projectPrivateProductTarballs({ products })).toThrow(message)
    }
  })
})

describe('root patch coverage validation', () => {
  const repo = createTempRepo('packages/utils', 'packages/app')
  const catalog = defineCatalog({})

  const makeUtilsWithPatches = () => {
    const utilsComposition = catalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
    })
    return packageJson(
      {
        name: '@test/utils',
        version: '1.0.0',
        pnpm: {
          patchedDependencies: {
            'some-pkg@1.0.0': 'packages/utils/patches/some-pkg@1.0.0.patch',
          },
        },
      },
      utilsComposition,
    )
  }

  const makeApp = (deps: WorkspacePackage[]) => {
    const appComposition = catalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/app',
      }),
      dependencies: {
        workspace: deps,
      },
    })
    return packageJson(
      {
        name: '@test/app',
        version: '1.0.0',
      },
      appComposition,
    )
  }

  it('passes when root config includes all required patches', async () => {
    const utils = makeUtilsWithPatches()
    const app = makeApp([utils])

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
      patchedDependencies: {
        'some-pkg@1.0.0': 'repos/upstream/packages/utils/patches/some-pkg@1.0.0.patch',
      },
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: repo.repoRoot,
    })
    expect(issues).toEqual([])
  })

  it('reports missing patch when root config omits a required patch', async () => {
    const utils = makeUtilsWithPatches()
    const app = makeApp([utils])

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: repo.repoRoot,
    })
    expect(issues).toHaveLength(1)
    expect(issues?.[0]).toMatchObject({
      severity: 'error',
      dependency: 'some-pkg@1.0.0',
      rule: 'root-patch-coverage',
    })
  })

  it('detects patches from transitive workspace deps', async () => {
    const transitiveRepo = createTempRepo('packages/utils', 'packages/app', 'packages/wrapper')
    const utils = makeUtilsWithPatches()
    const app = makeApp([utils])

    const wrapperComposition = catalog.compose({
      workspace: workspace({
        repoName: transitiveRepo.repoName,
        memberPath: 'packages/wrapper',
      }),
      dependencies: {
        workspace: [app],
      },
    })
    const wrapper = packageJson({ name: '@test/wrapper', version: '1.0.0' }, wrapperComposition)

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [wrapper],
      repoName: transitiveRepo.repoName,
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: transitiveRepo.repoRoot,
    })
    expect(issues).toHaveLength(1)
    expect(issues?.[0]).toMatchObject({
      rule: 'root-patch-coverage',
      dependency: 'some-pkg@1.0.0',
    })
  })

  it('passes when no packages declare patches', async () => {
    const utilsComposition = catalog.compose({
      workspace: workspace({
        repoName: repo.repoName,
        memberPath: 'packages/utils',
      }),
    })
    const plainUtils = packageJson({ name: '@test/utils', version: '1.0.0' }, utilsComposition)
    const app = makeApp([plainUtils])

    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      repoName: repo.repoName,
    })

    const issues = await workspaceFile.validate?.({
      location: '.',
      cwd: repo.repoRoot,
    })
    expect(issues).toEqual([])
  })
})
