// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

/*
 * Storybook lives in its own package so that `@overeng/utils` carries no
 * Storybook peers. pnpm links an optional peer into a package instance whenever
 * a matching version exists anywhere in the graph (pnpm/pnpm#10046), so optional
 * Storybook peers on `@overeng/utils` put Storybook, without React, under
 * every React-less consumer of utils and fail strict peer checks there.
 * Everything that depends on this package owns a Storybook install.
 */
const requiredPeerNames = ['@storybook/react-vite', 'storybook', 'vite'] as const
/* Only the story gate needs the Vitest browser stack; config-only consumers do not. */
const gatePeerNames = ['@vitest/browser-playwright', 'vitest'] as const

const deps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/utils-storybook' }),
  devDependencies: {
    workspace: [utilsPkg, utilsDevPkg],
    external: {
      ...catalog.pick(
        ...requiredPeerNames,
        ...gatePeerNames,
        '@effect/opentelemetry',
        '@effect/platform-node',
        '@effect/vitest',
        '@storybook/addon-a11y',
        '@types/node',
        '@types/react',
        '@vitest/browser',
        'effect',
        'playwright',
        'react',
        'react-dom',
        'typescript',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...requiredPeerNames, ...gatePeerNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/utils-storybook',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './config': exportEntry(
        { types: './dist/src/config/mod.d.ts', default: './src/config/mod.ts' },
        { environment: 'node' },
      ),
      './gate': exportEntry(
        { types: './dist/src/gate/mod.d.ts', default: './src/gate/mod.ts' },
        { environment: 'node' },
      ),
      './gate/cli': exportEntry(
        { types: './dist/src/gate/cli.d.ts', default: './src/gate/cli.ts' },
        { environment: 'node' },
      ),
      // Referenced by path from the gate's `test.setupFiles`, never imported
      // from Node: it runs inside the Vitest browser environment.
      './gate/setup': exportEntry(
        { types: './dist/src/gate/setup.d.ts', default: './src/gate/setup.ts' },
        { environment: 'browser' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './config': { types: './dist/src/config/mod.d.ts', default: './dist/src/config/mod.js' },
        './gate': { types: './dist/src/gate/mod.d.ts', default: './dist/src/gate/mod.js' },
        './gate/cli': { types: './dist/src/gate/cli.d.ts', default: './dist/src/gate/cli.js' },
        './gate/setup': {
          types: './dist/src/gate/setup.d.ts',
          default: './dist/src/gate/setup.js',
        },
      },
    },
    peerDependenciesMeta: Object.fromEntries(
      gatePeerNames.map((name) => [name, { optional: true }]),
    ),
  } satisfies PackageJsonInputData,
  deps,
)
