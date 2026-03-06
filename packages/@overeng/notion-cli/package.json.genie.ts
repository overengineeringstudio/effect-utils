import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import effectPathPkg from '../effect-path/package.json.genie.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import tuiCorePkg from '../tui-core/package.json.genie.ts'
import tuiReactPkg from '../tui-react/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

/** Effect packages not already in @overeng/utils or @overeng/tui-react */
const ownPeerDepNames = ['@effect/cli', '@effect/sql', '@effect/typeclass'] as const

const data = {
  name: '@overeng/notion-cli',
  ...privatePackageDefaults,
  patchedDependencies: {
    ...utilsPkg.data.patchedDependencies,
  },
  scripts: {
    storybook: 'storybook dev -p 6012',
    'storybook:build': 'storybook build',
  },
  pnpm: {
    patchedDependencies: {
      ...utilsPkg.data.pnpm?.patchedDependencies,
    },
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
    ),
  },
  // Inject tui-react so it resolves React from *this* package's .pnpm store,
  // preventing duplicate React instances across independent workspace stores.
  // See: requirements.md R8 (singleton runtimes)
  dependenciesMeta: {
    '@overeng/tui-react': { injected: true },
  },
  devDependencies: {
    ...utilsPkg.data.peerDependencies,
    ...tuiReactPkg.data.peerDependencies,
    ...catalog.pick(
      ...ownPeerDepNames,
      '@effect/vitest',
      '@overeng/utils-dev',
      '@storybook/react',
      '@storybook/react-vite',
      '@types/react',
      '@vitejs/plugin-react',
      'storybook',
      'vite',
      'vitest',
    ),
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    ...utilsPkg.data.peerDependencies,
    ...tuiReactPkg.data.peerDependencies,
    ...catalog.peers(...ownPeerDepNames),
  },
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [
      effectPathPkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      tuiCorePkg,
      tuiReactPkg,
      utilsDevPkg,
      utilsPkg,
    ],
    location: 'packages/@overeng/notion-cli',
  }),
} satisfies PackageJsonData)
