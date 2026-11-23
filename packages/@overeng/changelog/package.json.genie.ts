// @genie-bootstrap
import {
  catalog,
  exportEntry,
  firstPartyPackageDefaults,
  packageJson,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

export default packageJson(
  {
    name: '@overeng/changelog',
    ...firstPartyPackageDefaults,
    version: '0.1.0',
    type: 'module',
    description:
      'Structured product changelogs: typed entries, versioned build manifests, coverage enforcement and annotated screenshots',
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './node': exportEntry(
        { types: './dist/src/node/mod.d.ts', default: './src/node/mod.ts' },
        { environment: 'node' },
      ),
      './vite': exportEntry(
        { types: './dist/src/vite.d.ts', default: './src/vite.ts' },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './node': { types: './dist/src/node/mod.d.ts', default: './dist/src/node/mod.js' },
        './vite': { types: './dist/src/vite.d.ts', default: './dist/src/vite.js' },
      },
    },
  } satisfies PackageJsonInputData,
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/changelog' }),
    dependencies: { external: catalog.pick('@effect/platform-node', 'effect') },
    devDependencies: {
      external: catalog.pick('@effect/vitest', '@types/node', 'typescript', 'vite', 'vitest'),
    },
    peerDependencies: { external: catalog.pick('vite') },
  }),
)
