import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { packageJson } from '../mod.ts'
import { defineCatalog } from '../package-json/catalog.ts'
import { workspaceRootFromPackages } from '../package-json/mod.ts'
import { pnpmWorkspaceYamlFromPackage, pnpmWorkspaceYamlFromPackages } from './mod.ts'

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

describe('metadata-based workspace projections', () => {
  const repo = createTempRepo('packages/utils', 'packages/app')
  const catalog = defineCatalog({})
  const utilsComposition = catalog.compose({
    dir: repo.memberDirs['packages/utils']!,
  })
  const utils = packageJson(
    {
      name: '@test/utils',
      version: '1.0.0',
    },
    utilsComposition,
  )
  const appComposition = catalog.compose({
    dir: repo.memberDirs['packages/app']!,
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

  it('projects package-local workspace members from package metadata', () => {
    const workspace = pnpmWorkspaceYamlFromPackage({
      pkg: app,
      extraPackages: ['../examples'],
      dedupePeerDependents: true,
    })

    expect(workspace.data.packages).toEqual(['.', '../examples', '../utils'])
  })

  it('projects root workspace members recursively from package metadata', () => {
    const workspace = pnpmWorkspaceYamlFromPackages({
      dir: repo.repoRoot,
      packages: [app],
      extraPackages: ['packages/examples'],
      dedupePeerDependents: true,
    })

    expect(workspace.data.packages).toEqual(['packages/app', 'packages/examples', 'packages/utils'])
  })

  it('projects workspace root workspaces from package metadata', () => {
    const workspaceRoot = workspaceRootFromPackages({
      dir: repo.repoRoot,
      packages: [app],
      extraWorkspaces: ['packages/examples'],
      name: 'workspace-root',
      private: true,
    })

    expect(workspaceRoot.data.workspaces).toEqual([
      'packages/app',
      'packages/examples',
      'packages/utils',
    ])
  })
})
