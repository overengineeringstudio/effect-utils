import { pnpmPatchedDependencies } from '../../../genie/external.ts'
import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
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
const runtimeDeps = catalog.compose({
  workspace: workspaceMember('packages/@overeng/notion-cli'),
  dependencies: {
    workspace: [
      effectPathPkg,
      notionEffectClientPkg,
      notionEffectSchemaPkg,
      tuiCorePkg,
      tuiReactPkg,
      utilsPkg,
    ],
  },
  pnpm: {
    patchedDependencies: pnpmPatchedDependencies(),
  },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: {
      ...catalog.pick(
        ...ownPeerDepNames,
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/react',
        '@vitejs/plugin-react',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    workspace: [utilsPkg, tuiReactPkg],
    external: catalog.pick(...ownPeerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/notion-cli',
    ...privatePackageDefaults,
    scripts: {
      storybook: 'storybook dev -p 6012',
      'storybook:build': 'storybook build',
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
    // Inject tui-react so it resolves React from *this* package's .pnpm store,
    // preventing duplicate React instances across independent workspace stores.
    // See: requirements.md R8 (singleton runtimes)
    dependenciesMeta: {
      '@overeng/tui-react': { injected: true },
    },
  },
  runtimeDeps,
)
