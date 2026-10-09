// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

export default packageJson(
  {
    name: '@overeng/ai-gateway-conformance',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './cases/*': './cases/*',
      './case.schema.json': './case.schema.json',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './cases/*': './cases/*',
        './case.schema.json': './case.schema.json',
      },
    },
  } satisfies PackageJsonInputData,
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/ai-gateway-conformance' }),
    devDependencies: {
      external: catalog.pick('@types/node', 'typescript', 'effect'),
    },
    peerDependencies: { external: catalog.pick('effect') },
  }),
)
