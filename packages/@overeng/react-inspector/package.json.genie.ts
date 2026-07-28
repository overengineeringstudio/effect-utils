// @genie-bootstrap
import {
  catalog as repoCatalog,
  defineCatalog,
  workspaceMember,
  exportEntry,
  packageJson,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const catalog = defineCatalog({
  ...repoCatalog.pick(
    'is-dom',
    'react',
    '@storybook/react',
    '@storybook/react-vite',
    '@testing-library/react',
    '@testing-library/user-event',
    '@types/is-dom',
    '@types/react',
    '@vitejs/plugin-react',
    'happy-dom',
    'react-dom',
    'storybook',
    'typescript',
    'vite',
    'vitest',
  ),
  effect: '4.0.0-beta.99',
})

const peerDepNames = ['effect', 'react'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/react-inspector' }),
  dependencies: {
    external: {
      ...catalog.pick('is-dom'),
    },
  },
  devDependencies: {
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@storybook/react',
        '@storybook/react-vite',
        '@testing-library/react',
        '@testing-library/user-event',
        '@types/is-dom',
        '@types/react',
        '@vitejs/plugin-react',
        'happy-dom',
        'react-dom',
        'storybook',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: {
      effect: '^4.0.0-beta.99',
      ...catalog.pick('react'),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/react-inspector',
    /** Forked from react-inspector v8.0.0 (https://github.com/nicksenger/react-inspector) */
    version: '9.0.0',
    description: 'Browser DevTools-style React inspectors with native Effect 4 Schema support',
    /**
     * Fork of react-inspector, MIT (c) 2017 Xiaoyi Chen. The upstream notice is
     * required in all copies, so `LICENSE` ships with the package — the standalone
     * fork repo carries both and this copy had dropped them during a sync.
     */
    license: 'MIT',
    type: 'module',
    exports: {
      '.': exportEntry('./src/index.tsx', { environment: 'browser' }),
    },
    /**
     * Ships TypeScript source. The previous `publishConfig.exports` pointed at
     * `./dist/index.{js,cjs,d.ts}`, but no script builds `dist` — a published
     * package would have resolved its sole export to a file that does not exist.
     *
     * Publishing source keeps the published contract identical to the in-repo
     * one and matches how the consuming `@livestore/devtools-react` ships
     * (livestorejs/livestore#1497). Consumers need a bundler that compiles TSX
     * out of node_modules; Vite does, and that is the supported target.
     */
    publishConfig: {
      access: 'public',
    },
    scripts: {
      storybook: 'storybook dev -p 6011',
      'storybook:build': 'storybook build',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
