// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  publishedSourceExport,
  privatePackageDefaults,
  type PackageJsonInputData,
} from '../../../genie/internal.ts'
import browserPkg from '../effect-iroh-browser/package.json.genie.ts'

const workspaceDeps = catalog.compose({
  workspace: workspaceMember({ memberPath: 'packages/@overeng/effect-iroh-automerge' }),
  dependencies: {
    workspace: [browserPkg],
    external: catalog.pick('@automerge/automerge-repo'),
  },
  devDependencies: {
    external: catalog.pick(
      'effect',
      '@effect/vitest',
      '@types/node',
      'typescript',
      'vitest',
      '@automerge/automerge-repo-network-broadcastchannel',
    ),
  },
  peerDependencies: { external: catalog.pick('effect') },
})

export default packageJson(
  {
    name: '@overeng/effect-iroh-automerge',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'browser' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: {
        '.': publishedSourceExport('mod'),
      },
    },
  } satisfies PackageJsonInputData,
  workspaceDeps,
)
