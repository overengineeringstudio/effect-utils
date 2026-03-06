import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const peerDepNames = ['@effect/ai', '@effect/platform', 'effect'] as const

const data = {
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
      '@overeng/utils-dev',
      'effect',
      'vite',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [utilsDevPkg],
    location: 'packages/@overeng/effect-ai-claude-cli',
  }),
} satisfies PackageJsonData)
