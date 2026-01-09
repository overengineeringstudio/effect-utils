import { pkg } from '../../../genie/repo.ts'

export default pkg({
  name: '@overeng/effect-ai-claude-cli',
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
  devDependencies: ['@effect/ai', '@effect/platform', '@effect/vitest', 'effect', 'vite', 'vitest'],
  peerDependencies: {
    '@effect/ai': '>=0.32.0',
    '@effect/platform': '>=0.93.0',
    effect: '>=3.19.0',
  },
})
