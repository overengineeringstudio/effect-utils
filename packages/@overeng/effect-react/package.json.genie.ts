import {
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'

const peerDepNames = ['effect', 'react', 'react-aria-components', 'react-dom'] as const

export default packageJson({
  name: '@overeng/effect-react',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
    './react-aria': './src/react-aria/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
      './react-aria': './dist/react-aria/mod.js',
    },
  },
  scripts: {
    storybook: 'storybook dev -p 6009',
    'storybook:build': 'storybook build',
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@overeng/utils',
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
  peerDependencies: catalog.peers(...peerDepNames),
} satisfies PackageJsonData)
