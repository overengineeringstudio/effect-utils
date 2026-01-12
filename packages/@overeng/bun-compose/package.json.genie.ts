import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

export default packageJson({
  name: '@overeng/bun-compose',
  ...privatePackageDefaults,
  description: 'CLI for composing bun workspaces with git submodules',
  exports: {
    '.': './src/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './cli': './dist/cli.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/utils'),
  },
  devDependencies: {
    ...catalog.pick(
      '@effect/cli',
      '@effect/platform',
      '@effect/platform-node',
      '@effect/vitest',
      '@types/node',
      'effect',
      'typescript',
      'vitest',
    ),
  },
  peerDependencies: {
    ...utilsPkg.data.peerDependencies,
    '@effect/cli': `^${catalog['@effect/cli']}`,
  },
  patchedDependencies: {
    ...utilsPkg.data.patchedDependencies,
  },
})
