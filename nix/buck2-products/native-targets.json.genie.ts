import { projectBuckProductSourcePaths } from '../../genie/buck2/product-source-paths.ts'
import { nixOnlyPackages } from '../../genie/packages.ts'
import geniePkg from '../../packages/@overeng/genie/package.json.genie.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

/** Build-product targets distributed as substituted native Nix store paths. */
const products = [
  ...nixOnlyPackages.map(({ name, cratePath }) => ({
    cargoWorkspaceRoot: 'rust',
    kind: 'native',
    name,
    outputName: 'artifact.tar',
    sourcePaths: [cratePath, 'rust/Cargo.toml', 'rust/Cargo.lock', 'rust/third-party'].toSorted(),
    target: `effect_utils//${cratePath}:${name}-product`,
    version: '0.0.0',
  })),
  {
    kind: 'native',
    name: 'typescript-api-server',
    outputName: 'artifact.tar',
    sourcePaths: projectBuckProductSourcePaths({
      pkg: geniePkg,
      additionalPaths: ['packages/@overeng/buck2-tools', 'patches'],
    }),
    target: 'effect_utils//packages/@overeng/genie:typescript-api-server-product',
    version: '0.0.0',
  },
].toSorted((left, right) => left.name.localeCompare(right.name))

export default projectionArtifact.json({
  schemaVersion: 1,
  data: products,
  project: (products) => ({ products, schema: 'effect-utils/buck-native-targets/v1' }),
})
