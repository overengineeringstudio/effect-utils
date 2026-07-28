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
    publishConfig: {
      access: 'public',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          require: './dist/index.cjs',
          import: './dist/index.js',
        },
      },
    },
    scripts: {
      storybook: 'storybook dev -p 6011',
      'storybook:build': 'storybook build',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
