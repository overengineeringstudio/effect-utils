// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
  workspaceMember,
} from '../../../genie/internal.ts'

/**
 * No runtime dependencies and no `effect` peer: this package is the pure decision
 * layer for npm registry verification, so it stays consumable from any runtime
 * (including plain Node scripts and consumers on a different Effect major).
 */
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/npm-release' }),
  devDependencies: {
    external: {
      ...catalog.pick('@types/node', 'typescript', 'vitest'),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/npm-release',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry('./src/mod.ts', { environment: 'isomorphic-es2024' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
