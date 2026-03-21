import {
  catalog,
  workspaceMember,
  packageJson,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', 'react'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/react-inspector' }),
  dependencies: {
    external: {
      ...catalog.pick('is-dom'),
    },
  },
  devDependencies: {
    workspace: [utilsPkg],
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
    external: catalog.pick(...peerDepNames),
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
      '.': './src/index.tsx',
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
    peerDependenciesMeta: {
      effect: {
        optional: true,
      },
    },
  } satisfies PackageJsonData,
  workspaceDeps,
)
