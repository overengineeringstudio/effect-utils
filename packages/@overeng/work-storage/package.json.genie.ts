// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  publishedSourceExport,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

export default packageJson(
  {
    name: '@overeng/work-storage',
    ...privatePackageDefaults,
    description: 'Portable work-storage v1 contract and Effect reader',
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './protocol.schema.json': './protocol.schema.json',
      './fixtures/conformance.json': './fixtures/conformance.json',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': publishedSourceExport('mod'),
        './protocol.schema.json': './protocol.schema.json',
        './fixtures/conformance.json': './fixtures/conformance.json',
      },
    },
  } satisfies PackageJsonInputData,
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/work-storage' }),
    devDependencies: { external: catalog.pick('effect', '@effect/platform-node', '@effect/vitest', '@types/node', 'typescript', 'vitest', 'ajv') },
    peerDependencies: { external: catalog.pick('effect') },
  }),
)
