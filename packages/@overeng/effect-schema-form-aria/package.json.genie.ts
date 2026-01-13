import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

const peerDepNames = ['effect', 'react', 'react-aria-components', 'react-dom'] as const

export default packageJson({
  name: '@overeng/effect-schema-form-aria',
  ...privatePackageDefaults,
  exports: {
    '.': './src/mod.ts',
  },
  publishConfig: {
    access: 'public',
    exports: {
      '.': './dist/mod.js',
    },
  },
  dependencies: {
    ...catalog.pick('@overeng/effect-schema-form'),
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      '@storybook/react',
      '@storybook/react-vite',
      '@tailwindcss/vite',
      '@types/react',
      '@vitejs/plugin-react',
      'storybook',
      'tailwindcss',
      'vite',
      'vitest',
    ),
  },
  peerDependencies: catalog.peers(...peerDepNames),
})
