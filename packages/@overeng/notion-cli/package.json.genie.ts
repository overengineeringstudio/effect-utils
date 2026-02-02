import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
  validateSelfContainedPackage,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

/** Effect packages not already in @overeng/utils */
const ownPeerDepNames = ['@effect/cli', '@effect/sql', '@effect/typeclass'] as const

export default packageJson(
  {
    name: '@overeng/notion-cli',
    ...privatePackageDefaults,
    scripts: {
      ...effectLspScripts,
    },
    exports: {
      '.': './src/mod.ts',
      './config': './src/config-def.ts',
    },
    publishConfig: {
      access: 'public',
      bin: {
        notion: './dist/cli.js',
      },
      exports: {
        '.': './dist/mod.js',
        './config': './dist/config-def.js',
      },
    },
    dependencies: {
      ...catalog.pick(
        '@overeng/effect-path',
        '@overeng/notion-effect-client',
        '@overeng/notion-effect-schema',
        '@overeng/tui-core',
        '@overeng/tui-react',
        '@overeng/utils',
        'react',
      ),
    },
    devDependencies: {
      ...catalog.pick(
        ...Object.keys(utilsPkg.data.peerDependencies ?? {}),
        ...ownPeerDepNames,
        '@effect/vitest',
        '@types/react',
        'vitest',
      ),
      ...effectLspDevDeps(),
    },
    peerDependencies: {
      // Re-expose @overeng/utils peer deps + own additional peer deps
      ...utilsPkg.data.peerDependencies,
      ...catalog.peers(...ownPeerDepNames),
    },
  },
  { validate: validateSelfContainedPackage('@overeng/notion-cli') },
)
