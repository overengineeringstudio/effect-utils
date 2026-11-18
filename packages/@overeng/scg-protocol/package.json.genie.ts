// @genie-bootstrap
import { privatePackageDefaults } from '../../../genie/external.ts'
import { catalog, exportEntry, packageJson, workspaceMember } from '../../../genie/internal.ts'

export default packageJson(
  {
    name: '@overeng/scg-protocol',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './vectors': exportEntry(
        { types: './dist/src/vectors.d.ts', default: './src/vectors.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
  },
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/scg-protocol' }),
    dependencies: { external: catalog.pick('effect') },
    devDependencies: {
      external: catalog.pick('@types/node', '@types/bun', 'typescript', 'vitest', '@effect/vitest'),
    },
  }),
)
