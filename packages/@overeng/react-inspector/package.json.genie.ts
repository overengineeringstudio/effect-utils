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
  effect: '4.0.0-beta.98',
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
      effect: '^4.0.0-beta.97',
      ...catalog.pick('react'),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/react-inspector',
    /** Forked from react-inspector v8.0.0 (https://github.com/nicksenger/react-inspector) */
    version: '8.0.0',
    description: 'Power of Browser DevTools inspectors right inside your React app',
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
