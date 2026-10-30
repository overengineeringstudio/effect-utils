// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/alchemy-github' }),
  dependencies: {
    external: catalog.pick('@alchemy.run/github', 'libsodium-wrappers'),
  },
  devDependencies: {
    external: catalog.pick(
      'alchemy',
      'effect',
      '@effect/platform-node',
      '@effect/vitest',
      '@types/node',
      'typescript',
      'vitest',
      'vite',
    ),
  },
  peerDependencies: {
    external: catalog.peers('alchemy', 'effect'),
  },
})

export default packageJson(
  {
    name: '@overeng/alchemy-github',
    ...privatePackageDefaults,
    description: 'GitHub App and repository Ruleset resources for Alchemy v2',
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
