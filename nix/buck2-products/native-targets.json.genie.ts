import { nixOnlyPackages } from '../../genie/packages.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

/** Build-product targets distributed as substituted native Nix store paths. */
const products = [
  ...nixOnlyPackages.map(({ name, cratePath }) => ({
    cargoWorkspaceRoot: 'rust',
    kind: 'native',
    name,
    outputName: 'artifact.tar',
    target: `effect_utils//${cratePath}:${name}-product`,
    version: '0.0.0',
  })),
  {
    kind: 'native',
    name: 'typescript-api-server',
    outputName: 'artifact.tar',
    target: 'effect_utils//packages/@overeng/genie:typescript-api-server-product',
    version: '0.0.0',
  },
].toSorted((left, right) => left.name.localeCompare(right.name))

export default projectionArtifact.json({
  schemaVersion: 1,
  data: products,
  project: (products) => ({ products, schema: 'effect-utils/buck-native-targets/v1' }),
})
