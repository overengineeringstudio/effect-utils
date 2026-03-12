import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { packageJson } from '../mod.ts'
import { defineCatalog } from '../package-json/catalog.ts'
import { pnpmWorkspaceYaml } from './mod.ts'

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

const workspace = ({ repoName, memberPath }: { repoName: string; memberPath: string }) => ({
  repoName,
  memberPath,
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

  it('projects package-local workspace members from package metadata', () => {
    const workspaceFile = pnpmWorkspaceYaml.package({
      pkg: app,
      packages: [example],
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual(['.', '../examples/basic', '../utils'])
  })

  it('projects root workspace members recursively from package metadata', () => {
    const workspaceFile = pnpmWorkspaceYaml.root({
      packages: [app],
      extraPackages: ['packages/examples'],
      dedupePeerDependents: true,
    })

    expect(workspaceFile.data.packages).toEqual([
      'packages/app',
      'packages/examples',
      'packages/utils',
    ])
  })

  it('projects workspace root workspaces from package metadata', () => {
    const workspaceRoot = packageJson.aggregateFromPackages({
      packages: [app],
      name: 'workspace-root',
    })

    expect(workspaceRoot.data.workspaces).toEqual(['packages/app', 'packages/utils'])
  })
})
