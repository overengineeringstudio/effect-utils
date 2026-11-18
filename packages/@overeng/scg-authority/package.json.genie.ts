// @genie-bootstrap
import { privatePackageDefaults } from '../../../genie/external.ts'
import { catalog, exportEntry, packageJson, workspaceMember } from '../../../genie/internal.ts'
import scgProtocolPkg from '../scg-protocol/package.json.genie.ts'

export default packageJson(
  {
    name: '@overeng/scg-authority',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'bun' },
      ),
    },
  },
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/scg-authority' }),
    dependencies: { workspace: [scgProtocolPkg], external: catalog.pick('effect') },
    devDependencies: {
      external: catalog.pick(
        '@types/node',
        '@types/bun',
        'typescript',
        'vitest',
        '@effect/vitest',
        '@effect/platform-node',
      ),
    },
  }),
)
