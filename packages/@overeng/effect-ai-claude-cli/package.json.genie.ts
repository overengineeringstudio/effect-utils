import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'

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
  scripts: {
    ...effectLspScripts,
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
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
