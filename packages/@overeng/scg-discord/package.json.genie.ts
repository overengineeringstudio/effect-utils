// @genie-bootstrap
import {
  catalog,
  workspaceMember,
  exportEntry,
  packageJson,
  privatePackageDefaults,
} from '../../../genie/internal.ts'
import authorityPkg from '../scg-authority/package.json.genie.ts'
import protocolPkg from '../scg-protocol/package.json.genie.ts'

export default packageJson(
  {
    name: '@overeng/scg-discord',
    ...privatePackageDefaults,
    exports: {
      '.': exportEntry(
        { types: './dist/src/mod.d.ts', default: './src/mod.ts' },
        { environment: 'bun' },
      ),
      './card': exportEntry(
        { types: './dist/src/card.d.ts', default: './src/card.ts' },
        { environment: 'isomorphic-es2024' },
      ),
    },
  },
  catalog.compose({
    workspace: workspaceMember({ memberPath: 'packages/@overeng/scg-discord' }),
    dependencies: { workspace: [protocolPkg], external: catalog.pick('effect') },
    devDependencies: {
      workspace: [authorityPkg],
      external: catalog.pick(
        '@effect/vitest',
        '@effect/platform-node',
        '@types/bun',
        '@types/node',
        'typescript',
        'vitest',
      ),
    },
  }),
)
