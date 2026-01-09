import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
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
  devDependencies: [
    '@effect/cli',
    '@effect/platform',
    '@effect/platform-node',
    '@effect/vitest',
    '@types/node',
    'effect',
    'typescript',
    'vitest',
  ],
  peerDependencies: {
    '@effect/cli': '^',
    '@effect/platform': '^',
    '@effect/platform-node': '^',
    effect: '^',
  },
})
