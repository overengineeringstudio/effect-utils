import {
  catalog,
  workspaceMember,
  packageJson,
  privatePackageDefaults,
  type PackageJsonData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const peerDepNames = ['effect', 'react', 'react-aria-components', 'react-dom'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-react' }),
  devDependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
        '@storybook/react',
        '@storybook/react-vite',
        '@types/react',
        '@types/react-dom',
        '@vitejs/plugin-react',
        'typescript',
        'storybook',
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
  } satisfies PackageJsonData,
  workspaceDeps,
)
