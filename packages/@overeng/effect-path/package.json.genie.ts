import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/effect-path',
  version: '0.1.0',
  private: true,
  type: 'module',
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  devDependencies: ['@effect/platform', '@effect/vitest', '@types/node', 'effect', 'vitest'],
  peerDependencies: {
    '@effect/platform': '^',
    effect: '^',
  },
})
