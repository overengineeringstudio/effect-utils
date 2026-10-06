// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

export default packageJson(
  {
    name: '@overeng/outline',
    version: '0.1.0',
    type: 'module',
    description: 'Theme-free document outline models and accessible React navigation',
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
      './model': exportEntry(
        { types: './dist/src/model.d.ts', default: './src/model.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': { types: './dist/src/mod.d.ts', default: './dist/src/mod.js' },
        './model': { types: './dist/src/model.d.ts', default: './dist/src/model.js' },
      },
    },
  } satisfies PackageJsonInputData,
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/outline' }),
    devDependencies: {
      external: catalog.pick(
        'react',
        'react-dom',
        'react-aria-components',
        '@types/react',
        '@types/react-dom',
        'typescript',
        'vitest',
        '@effect/vitest',
        'effect',
      ),
    },
    peerDependencies: { external: catalog.pick('react', 'react-dom', 'react-aria-components') },
  }),
)
