// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
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
    external: catalog.pick(
      'effect',
      '@storybook/react',
      '@storybook/react-vite',
      '@stylexjs/stylex',
      '@stylexjs/unplugin',
      '@types/react',
      '@types/react-dom',
      '@vitejs/plugin-react',
      'storybook',
      'tailwind-stylex',
      'typescript',
      'vite',
      'vitest',
    ),
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
      '.': exportEntry('./src/mod.ts', { environment: 'browser' }),
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
