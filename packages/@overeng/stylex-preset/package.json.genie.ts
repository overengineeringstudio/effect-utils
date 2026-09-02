// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'

const peerDepNames = ['@stylexjs/stylex'] as const
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/stylex-preset' }),
  dependencies: {
    external: catalog.pick('@stylexjs/unplugin', 'unplugin'),
  },
  devDependencies: {
    external: catalog.pick(...peerDepNames, 'typescript', 'vite', 'vitest'),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/stylex-preset',
    ...privatePackageDefaults,
    description: 'Shared StyleX design tokens, preflight styles, and Vite integration',
    exports: {
      './tokens.stylex': exportEntry(
        { types: './dist/src/tokens.stylex.d.ts', default: './src/tokens.stylex.ts' },
        { environment: 'browser' },
      ),
      './preflight.css': exportEntry('./src/preflight.css', { environment: 'browser' }),
      './vite': exportEntry(
        {
          types: './src/vite-types.d.ts',
          default: './src/vite.js',
        },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        './tokens.stylex': './dist/tokens.stylex.js',
        './preflight.css': './dist/preflight.css',
        './vite': './dist/vite.js',
      },
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
