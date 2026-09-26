// @genie-bootstrap
import {
  catalog as repoCatalog,
  defineCatalog,
  workspaceMember,
  exportEntry,
  packageJson,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsPkg from '../utils/package.json.genie.ts'

const catalog = defineCatalog({
  ...repoCatalog.pick(
    'is-dom',
    'react',
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
    'typescript',
    'vite',
    'vitest',
  ),
  effect: '4.0.0-rc.113',
})

const peerDepNames = ['effect', 'react'] as const
const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/react-inspector' }),
  dependencies: {
    external: {
      ...catalog.pick('is-dom'),
    },
  },
  devDependencies: {
    workspace: [utilsPkg],
    external: {
      ...catalog.pick(
        ...peerDepNames,
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
        'typescript',
        'vite',
        'vitest',
      ),
    },
  },
  peerDependencies: {
    external: {
      effect: '^4.0.0-rc.113',
      ...catalog.pick('react'),
    },
  },
})

export default packageJson(
  {
    name: '@overeng/react-inspector',
    /** Forked from react-inspector v8.0.0 (https://github.com/nicksenger/react-inspector) */
    version: '9.0.0',
    description: 'Browser DevTools-style React inspectors with native Effect 4 Schema support',
    /**
     * Fork of react-inspector, MIT (c) 2017 Xiaoyi Chen. The upstream notice is
     * required in all copies, so `LICENSE` ships with the package — the standalone
     * fork repo carries both and this copy had dropped them during a sync.
     */
    license: 'MIT',
    type: 'module',
    exports: {
      '.': exportEntry(
        { types: './dist/src/index.d.ts', default: './src/index.tsx' },
        { environment: 'browser' },
      ),
    },
    /** Ship the Buck emit's JavaScript and declarations from the same dist tree. */
    files: ['package.json', 'dist', 'src', '!dist/**/*.tsbuildinfo'],
    publishConfig: {
      access: 'public',
      exports: {
        '.': {
          types: './dist/src/index.d.ts',
          default: './dist/src/index.js',
        },
      },
    },
    scripts: {
      /** The standalone pack build writes to the same layout as the Buck emit. */
      build:
        'tsc --project tsconfig.json --noEmit false --outDir dist --declaration true --declarationMap false --composite false --incremental false',
      storybook: 'storybook dev -p 6011',
      'storybook:build': 'storybook build',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
