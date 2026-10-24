// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import geniePkg from '../genie/package.json.genie.ts'
import schemaCodegenPkg from '../schema-codegen/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/schema-codegen-swift' }),
  dependencies: { workspace: [schemaCodegenPkg, geniePkg], external: catalog.pick('effect') },
  devDependencies: {
    external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/schema-codegen-swift',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './genie': exportEntry(
        { types: './dist/src/genie.d.ts', default: './src/genie.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './genie': { types: './dist/src/genie.d.ts', default: './dist/src/genie.js' },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
