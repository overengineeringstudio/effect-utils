import {
  bunWorkspacesWithDeps,
  catalog,
  effectLspDevDeps,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import schemaFormPkg from '../effect-schema-form/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['react-aria-components', 'react-dom'] as const

const data = {
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
      '@overeng/utils',
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
} satisfies PackageJsonData

export default packageJson({
  ...data,
  workspaces: bunWorkspacesWithDeps({
    pkg: data,
    deps: [schemaFormPkg, utilsPkg],
    location: 'packages/@overeng/effect-schema-form-aria',
  }),
} satisfies PackageJsonData)
