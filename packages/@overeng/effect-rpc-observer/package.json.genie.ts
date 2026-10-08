// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const peerDepNames = ['effect'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-rpc-observer' }),
  devDependencies: {
    external: catalog.pick(...peerDepNames, 'typescript', 'vitest', '@effect/vitest'),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/effect-rpc-observer',
    version: '0.1.0',
    description: 'Scoped, content-free Effect RPC protocol observation with opt-in capture sinks',
    license: 'MIT',
    type: 'module',
    files: ['package.json', 'dist', 'src', '!dist/**/*.tsbuildinfo'],
    exports: {
      '.': exportEntry(
        { types: './dist/src/index.d.ts', default: './src/index.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/index.d.ts', default: './dist/src/index.js' },
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
