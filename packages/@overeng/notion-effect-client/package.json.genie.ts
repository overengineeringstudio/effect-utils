import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/notion-effect-client',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/mod.ts',
    './test': './src/test/integration/setup.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: ['@overeng/notion-effect-schema'],
  devDependencies: [
    '@effect/platform',
    '@effect/vitest',
    '@overeng/utils',
    '@types/node',
    'effect',
    'vitest',
  ],
  peerDependencies: {
    '@effect/platform': '^',
    effect: '^',
  },
})
