import {
  catalog,
  effectLspDevDeps,
  effectLspScripts,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import schemaFormPkg from '../effect-schema-form/package.json.genie.ts'

const peerDepNames = ['react-aria-components', 'react-dom'] as const

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
  scripts: {
    ...effectLspScripts,
    storybook: 'storybook dev -p 6010',
    'storybook:build': 'storybook build',
  },
  dependencies: {
    ...catalog.pick('@overeng/effect-schema-form'),
  },
  devDependencies: {
    ...catalog.pick(
      ...peerDepNames,
      // From @overeng/effect-schema-form peer deps
      'effect',
      'react',
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
    ...effectLspDevDeps(),
  },
  peerDependencies: {
    // Expose @overeng/effect-schema-form peer deps transitively (consumers need them)
    ...schemaFormPkg.data.peerDependencies,
    ...catalog.peers(...peerDepNames),
  },
})
