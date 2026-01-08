import { catalog, rootPackageJson } from './genie/repo.ts'
import { packageJSON } from './packages/@overeng/genie/src/lib/mod.ts'

export default packageJSON({
  name: 'effect-notion',
  private: true,
  workspaces: ['packages/**', 'scripts/**', 'context/**'],
  type: 'module',
  scripts: {
    prepare: 'effect-language-service patch || true',
  },
  devDependencies: rootPackageJson.devDependencies,
  // Note: catalog defined inline for bun monorepo compatibility (long-term migration)
  catalog,
  patchedDependencies: rootPackageJson.pnpm.patchedDependencies,
})
