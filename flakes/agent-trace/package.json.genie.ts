// @genie-bootstrap
import {
  catalog,
  packageJson,
  privatePackageComposition,
  privatePackageDefaults,
  workspaceMember,
} from '../../genie/repo.ts'
import schemaRegistryPkg from '../schema-registry/package.json.genie.ts'
const composition = privatePackageComposition({
  workspace: workspaceMember('flakes/agent-trace'),
  dependencies: { workspace: [schemaRegistryPkg], external: catalog.pick('effect') },
  devDependencies: { external: catalog.pick('@types/node', 'typescript', 'vitest') },
})
export default packageJson(
  {
    name: '@schickling/agent-trace',
    ...privatePackageDefaults,
    exports: { '.': './src/mod.ts' },
    scripts: {
      generate: 'bun src/generator.ts generate',
      'generate:check': 'bun src/generator.ts check',
      'fixtures:generate': 'bun src/fixture-corpus.ts generate',
      'fixtures:check': 'bun src/fixture-corpus.ts check',
      typecheck: 'tsc -p tsconfig.json --noEmit',
      'typecheck:negative': 'bun src/negative-check.ts',
      test: 'vitest run --exclude "dist/**" --testTimeout=30000',
      check:
        'pnpm run typecheck && pnpm run typecheck:negative && pnpm run test && pnpm run generate:check && pnpm run fixtures:check',
    },
  },
  composition,
)
