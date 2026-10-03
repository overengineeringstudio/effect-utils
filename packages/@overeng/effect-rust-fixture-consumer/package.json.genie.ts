// @genie-bootstrap
import {
  catalog,
  exportEntry,
  packageJson,
  privatePackageDefaults,
  workspaceMember,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import effectRustPkg from '../effect-rust/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-rust-fixture-consumer' }),
  dependencies: {
    workspace: [effectRustPkg],
    external: catalog.pick('effect'),
  },
  devDependencies: { external: catalog.pick('@types/node', 'typescript') },
})

export default packageJson(
  {
    name: '@overeng/effect-rust-fixture-consumer',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'node' },
      ),
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
