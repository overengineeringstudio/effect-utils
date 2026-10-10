// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-iroh' }),
  dependencies: { external: catalog.pick('effect', '@number0/iroh') },
  devDependencies: {
    external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-iroh',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: { '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' } },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
