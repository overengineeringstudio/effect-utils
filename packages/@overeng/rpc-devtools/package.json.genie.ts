// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import explorerReactPkg from '../effect-rpc-explorer-react/package.json.genie.ts'
import explorerPkg from '../effect-rpc-explorer/package.json.genie.ts'
import observerPkg from '../effect-rpc-observer/package.json.genie.ts'
import metersPkg from '../meters/package.json.genie.ts'

const peers = ['effect', 'react', 'react-dom', 'react-aria-components', '@stylexjs/stylex'] as const
const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/rpc-devtools' }),
  dependencies: { workspace: [explorerPkg, explorerReactPkg, observerPkg, metersPkg] },
  devDependencies: {
    external: catalog.pick(...peers, 'typescript', 'vitest', '@effect/vitest', '@types/react'),
  },
  peerDependencies: { external: catalog.pick(...peers) },
})
export default packageJson(
  {
    name: '@overeng/rpc-devtools',
    version: '0.1.0',
    license: 'MIT',
    type: 'module',
    description: 'Scoped RPC meters and lazy explorer panels for host-owned developer tools',
    files: ['package.json', 'dist', 'src', '!dist/**/*.tsbuildinfo'],
    exports: {
      './core': exportEntry(
        { types: './dist/src/core.d.ts', default: './src/core.ts' },
        { environment: 'isomorphic-es2024' },
      ),
      './react': exportEntry(
        { types: './dist/src/react.d.ts', default: './src/react.tsx' },
        { environment: 'browser' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        './core': { types: './dist/src/core.d.ts', default: './dist/src/core.js' },
        './react': { types: './dist/src/react.d.ts', default: './dist/src/react.js' },
      },
    },
  } satisfies PackageJsonInputData,
  deps,
)
