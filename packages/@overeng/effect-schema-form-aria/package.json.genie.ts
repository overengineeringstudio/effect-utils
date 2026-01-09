import { pkg, privatePackageDefaults } from '../../../genie/repo.ts'

export default pkg.package({
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
  dependencies: ['@overeng/effect-schema-form'],
  devDependencies: [
    '@storybook/react',
    '@storybook/react-vite',
    '@tailwindcss/vite',
    '@types/react',
    '@vitejs/plugin-react',
    'effect',
    'react',
    'react-aria-components',
    'react-dom',
    'storybook',
    'tailwindcss',
    'vite',
    'vitest',
  ],
  peerDependencies: {
    effect: '^',
    react: '^',
    'react-aria-components': '^',
    'react-dom': '^',
  },
})
