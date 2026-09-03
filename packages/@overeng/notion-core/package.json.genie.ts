// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/notion-core' }),
  devDependencies: {
    workspace: [utilsDevPkg],
    // utils-dev is injected into this package's pnpm closure and peers on the
    // repository's Effect 3 cohort. Pin that peer locally so pnpm cannot satisfy
    // it with react-inspector's intentionally separate Effect 4 development copy.
    external: catalog.pick('@types/node', 'effect', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/notion-core',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': './dist/mod.js',
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
