import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import schemaFormPkg from '../effect-schema-form/package.json.genie.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['react-aria-components', 'react-dom'] as const
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-schema-form-aria' }),
  dependencies: {
    workspace: [schemaFormPkg],
  },
  devDependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        'effect',
        'react',
        '@storybook/react',
        '@storybook/react-vite',
        '@tailwindcss/vite',
        '@types/react',
        '@vitejs/plugin-react',
        'storybook',
        'tailwindcss',
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    workspace: [schemaFormPkg],
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
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
  },
  runtimeDeps,
)
