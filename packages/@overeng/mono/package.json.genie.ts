import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

/** Effect packages not already in @overeng/utils */
const ownPeerDepNames = ['@effect/cli'] as const

export default packageJson({
  ...privatePackageDefaults,
  name: '@overeng/mono',
  scripts: {
    ...effectLspScripts,
  },
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick(
      '@overeng/utils',
      '@effect-atom/atom',
      '@effect-atom/atom-react',
      '@opentui/core',
      '@opentui/react',
      'react',
      '@mariozechner/pi-tui',
    ),
  },
  devDependencies: {
    ...catalog.pick(
      ...Object.keys(utilsPkg.data.peerDependencies ?? {}),
      ...ownPeerDepNames,
      '@types/node',
      '@types/react',
      'vitest',
      '@effect/vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Re-expose @overeng/utils peer deps + own additional peer deps
    ...utilsPkg.data.peerDependencies,
    ...catalog.peers(...ownPeerDepNames),
  },
})
