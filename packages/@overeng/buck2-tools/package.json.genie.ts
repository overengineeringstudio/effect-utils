// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  publishedSourceExport,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import utilsDevPkg from '../utils-dev/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/buck2-tools' }),
  dependencies: { external: catalog.pick('acorn', 'acorn-walk') },
  devDependencies: {
    workspace: [utilsDevPkg],
    external: catalog.pick('@types/bun', '@types/node', 'typescript', 'vitest'),
  },
})

export default packageJson(
  {
    name: '@overeng/buck2-tools',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
      './editor-view-lifecycle': exportEntry(
        {
          types: './dist/src/editor-view-lifecycle.d.ts',
          default: './src/editor-view-lifecycle.ts',
        },
        { environment: 'node' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': publishedSourceExport('mod'),
        './editor-view-lifecycle': publishedSourceExport('editor-view-lifecycle'),
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
