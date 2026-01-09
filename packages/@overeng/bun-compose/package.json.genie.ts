import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/bun-compose',
  version: '0.1.0',
  private: true,
  description: 'CLI for composing bun workspaces with git submodules',
  type: 'module',
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
