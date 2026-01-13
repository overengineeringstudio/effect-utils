import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

const peerDepNames = ['@effect/ai', '@effect/platform', 'effect'] as const

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
  peerDependencies: catalog.peers(...peerDepNames),
})
