import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import notionEffectClientPkg from '../notion-effect-client/package.json.genie.ts'
import notionEffectSchemaPkg from '../notion-effect-schema/package.json.genie.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', 'react', 'react-reconciler'] as const

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-react' }),
  dependencies: {
    workspace: [notionEffectClientPkg, notionEffectSchemaPkg],
    external: catalog.pick('@effect/platform'),
  },
  devDependencies: {
    workspace: [utilsDevPkg, utilsPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@effect/vitest',
        '@storybook/react',
        '@storybook/react-vite',
        '@types/node',
        '@types/react',
        '@types/react-dom',
        '@types/react-reconciler',
        'react-dom',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
  mode: 'install',
})

export default packageJson(
  {
    name: '@overeng/notion-react',
    ...privatePackageDefaults,
    exports: {
      '.': './src/mod.ts',
      './renderer': './src/renderer/mod.ts',
      './test': './src/test/integration/setup.ts',
      './web': './src/web/mod.ts',
      './web/styles.css': './src/web/styles.css',
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
        './renderer': './dist/renderer/mod.js',
        './web': './dist/web/mod.js',
        './web/styles.css': './dist/web/styles.css',
      },
    },
    scripts: {
      storybook: 'storybook dev -p 6014',
      'storybook:build': 'storybook build',
      // Integration + e2e tests hit the live Notion API. Both require
      // `NOTION_TOKEN` and `NOTION_TEST_PARENT_PAGE_ID` (tests skip silently
      // when either is missing). Source the package-local `.envrc.local`
      // via direnv or run `op-proxy` inline. See helpers.ts for details.
      'test:integration': 'vitest run --config vitest.integration.config.ts',
      'test:integration:e2e': 'vitest run --config vitest.integration.config.ts e2e',
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
