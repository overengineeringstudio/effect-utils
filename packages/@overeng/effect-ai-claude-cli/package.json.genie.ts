import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

export default packageJson({
  name: '@overeng/effect-ai-claude-cli',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  devDependencies: {
    ...catalog.pick(
      '@effect/ai',
      '@effect/platform',
      '@effect/vitest',
      'effect',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: {
    '@effect/ai': '>=0.32.0',
    '@effect/platform': '>=0.93.0',
    effect: '>=3.19.0',
  },
})
