import { catalog, packageJson, privatePackageDefaults } from '../../../genie/internal.ts'

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
    ),
  },
  peerDependencies: {
    effect: `^${catalog.effect}`,
    react: `^${catalog.react}`,
    'react-aria-components': `^${catalog['react-aria-components']}`,
    'react-dom': `^${catalog['react-dom']}`,
  },
})
