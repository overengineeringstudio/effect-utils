// @genie-bootstrap
import {
  catalog,
  packageJson,
  privatePackageComposition,
  privatePackageDefaults,
  workspaceMember,
} from '../../genie/repo.ts'

const composition = privatePackageComposition({
  workspace: workspaceMember('flakes/schema-registry'),
  dependencies: { external: catalog.pick('effect') },
  devDependencies: { external: catalog.pick('@types/node', 'typescript', 'vitest') },
})

export default packageJson(
  {
    name: '@schickling/schema-registry',
    ...privatePackageDefaults,
    scripts: {
      build: 'tsc -p tsconfig.json --emitDeclarationOnly',
      check: 'pnpm run build && pnpm run test',
      test: "vitest run --exclude 'dist/**' --testTimeout=30000",
      typecheck: 'tsc -p tsconfig.json --noEmit',
    },
    exports: { '.': './src/mod.ts' },
  },
  composition,
)
