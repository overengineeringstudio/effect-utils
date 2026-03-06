import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', 'react'] as const

const data = {
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
  dependencies: {
    ...catalog.pick('is-dom'),
  },
  devDependencies: {
    ...effectLspDevDeps(),
    ...catalog.pick(
      ...peerDepNames,
      '@overeng/utils',
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
      'vite',
      'vitest',
    ),
  },
  peerDependencies: catalog.peers(...peerDepNames),
  peerDependenciesMeta: {
    effect: {
      optional: true,
    },
  },
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [utilsPkg],
    location: 'packages/@overeng/react-inspector',
  }),
} satisfies PackageJsonData)
