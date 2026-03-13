import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { packageJson } from '../mod.ts'
import { defineCatalog } from '../package-json/catalog.ts'
import { pnpmWorkspaceYaml, projectPnpmPackageClosure } from './mod.ts'

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
