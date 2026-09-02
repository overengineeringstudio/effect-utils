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
/**
 * Browser-pure by contract: this package carries design tokens and a reset
 * stylesheet, and must never grow a build-tool dependency (VRS stylex R11).
 * StyleX build integration lives in `@overeng/utils/node/stylex`.
 */
const runtimeDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/stylex-tokens' }),
  devDependencies: {
    external: catalog.pick(...peerDepNames, 'typescript'),
  },
  peerDependencies: {
    external: catalog.pick(...peerDepNames),
  },
})

export default packageJson(
  {
    name: '@overeng/stylex-tokens',
    ...privatePackageDefaults,
    description: 'Shared StyleX design-token scales and reset stylesheet (browser-only)',
    exports: {
      './tokens.stylex': exportEntry('./src/tokens.stylex.ts', { environment: 'browser' }),
      './preflight.css': exportEntry('./src/preflight.css', { environment: 'browser' }),
    },
    publishConfig: {
      access: 'public',
      exports: {
        './tokens.stylex': './dist/tokens.stylex.js',
        './preflight.css': './dist/preflight.css',
      },
    },
  } satisfies PackageJsonInputData,
  runtimeDeps,
)
