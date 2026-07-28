// @genie-bootstrap
import {
  catalog as repoCatalog,
  defineCatalog,
  workspaceMember,
  exportEntry,
  packageJson,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

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
  effect: '4.0.0-beta.99',
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
      effect: '^4.0.0-beta.99',
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
      '.': exportEntry('./src/index.tsx', { environment: 'browser' }),
    },
    /**
     * Pin the packed contents. `dist/` is a gitignored side effect of
     * `tsc --build` on this package's own `tsconfig.json`, and npm only consults
     * a *package-local* ignore file — this one lists `.vercel` only — so the repo
     * root's `dist` entry does not apply at pack time. The tarball therefore
     * varied by 169 files depending on whether a typecheck had run: 236 entries
     * after `ts:check`, 67 from a clean checkout.
     */
    files: ['package.json', 'src'],
    /**
     * Ship TypeScript source rather than the `tsc --build` output. The previous
     * `publishConfig.exports` mapped `.` into that `dist/`, which made the
     * published entry point depend on build order — and its `require` condition
     * named `./dist/index.cjs`, which nothing has ever emitted.
     *
     * Publishing source keeps the packed contract identical to the in-repo one,
     * so the two cannot drift, and matches how the consuming
     * `@livestore/devtools-react` ships (livestorejs/livestore#1497). Consumers
     * need a bundler that compiles TSX out of node_modules; Vite does, and that
     * is the supported target.
     */
    publishConfig: {
      access: 'public',
    },
    scripts: {
      storybook: 'storybook dev -p 6011',
      'storybook:build': 'storybook build',
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
