import { describe, expect, it } from 'vitest'

import { defineCatalog, packageJson } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { projectBuckProductSourcePaths } from './product-source-paths.ts'

describe('Buck product source projection', () => {
  it('includes recursive workspace dependencies but excludes unrelated packages', () => {
    const catalog = defineCatalog({})
    const workspace = (memberPath: string) => ({ repoName: 'fixture', memberPath })
    const leaf = packageJson(
      { name: '@fixture/leaf', version: '1.0.0' },
      catalog.compose({ workspace: workspace('packages/leaf') }),
    )
    const middle = packageJson(
      { name: '@fixture/middle', version: '1.0.0' },
      catalog.compose({
        workspace: workspace('packages/middle'),
        dependencies: { workspace: [leaf] },
      }),
    )
    const app = packageJson(
      { name: '@fixture/app', version: '1.0.0' },
      catalog.compose({
        workspace: workspace('packages/app'),
        dependencies: { workspace: [middle] },
      }),
    )

    expect(projectBuckProductSourcePaths({ pkg: app, additionalPaths: ['buck2/BUCK'] })).toEqual([
      'buck2/BUCK',
      'package.json',
      'packages/app',
      'packages/leaf',
      'packages/middle',
      'pnpm-workspace.yaml',
    ])
  })
})
