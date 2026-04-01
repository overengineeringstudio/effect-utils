import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { catalog } from './genie/external.ts'
import { commonPnpmWorkspaceData, pnpmWorkspaceYaml } from './genie/internal.ts'
import { rootWorkspacePackages } from './package.json.genie.ts'
import { validateCatalogPeerDeps } from './packages/@overeng/genie/src/runtime/catalog-peer-deps/mod.ts'

const base = pnpmWorkspaceYaml.root({
  packages: rootWorkspacePackages,
  repoName: 'effect-utils',
  ...commonPnpmWorkspaceData,
})

export default {
  ...base,
  validate: (ctx: Parameters<NonNullable<typeof base.validate>>[0]) => {
    const baseIssues = base.validate?.(ctx) ?? []

    let lockfileContent: string
    try {
      lockfileContent = readFileSync(join(ctx.cwd, 'pnpm-lock.yaml'), 'utf-8')
    } catch {
      return baseIssues
    }

    return [
      ...baseIssues,
      ...validateCatalogPeerDeps({
        catalog,
        lockfileContent,
        peerDependencyRules: commonPnpmWorkspaceData.peerDependencyRules,
      }),
    ]
  },
}
