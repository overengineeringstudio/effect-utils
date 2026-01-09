import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/genie',
  version: '0.1.0',
  private: true,
  bin: {
    genie: './bin/genie',
  },
  type: 'module',
  exports: {
    '.': './src/lib/mod.ts',
    './cli': './src/cli.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/lib/mod.js',
      './cli': './dist/cli.js',
    },
  },
  devDependencies: [
    '@effect/cli',
    '@effect/platform',
    '@effect/platform-node',
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
