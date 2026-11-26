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

export default packageJson(
  {
    name: '@overeng/game-laws',
    description: 'Caller-adapted fast-check properties for deterministic game rules',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
    publishConfig: {
      access: 'public',
      exports: { '.': publishedSourceExport('mod') },
    },
  } satisfies PackageJsonInputData,
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/game-laws' }),
    devDependencies: {
      external: catalog.pick('fast-check', '@types/node', 'typescript', 'vitest'),
    },
    peerDependencies: { external: catalog.pick('fast-check') },
  }),
)
