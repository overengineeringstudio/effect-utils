// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
} from '../../../genie/internal.ts'
import geniePkg from '../genie/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

export default packageJson(
  {
    name: '@overeng/genie-smalltalk',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './testing': exportEntry(
        { types: './dist/src/testing.d.ts', default: './src/testing.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './testing': { types: './dist/src/testing.d.ts', default: './dist/src/testing.js' },
      },
    },
  },
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/genie-smalltalk' }),
    dependencies: { workspace: [geniePkg], external: catalog.pick('effect') },
    devDependencies: {
      workspace: [utilsDevPkg],
      external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vitest'),
    },
  }),
)
