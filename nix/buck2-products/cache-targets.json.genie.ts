import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import { buckProductSourceEntries } from './from-source-products.nix.genie.ts'

export default projectionArtifact.json({
  schemaVersion: 1,
  data: buckProductSourceEntries,
  project: (products) => ({
    products,
    schema: 'effect-utils/buck-cache-targets/v1',
  }),
})
