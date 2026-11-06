import { productionHelpers } from '../../genie/buck2/production-helpers.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'
import cacheTargets from './cache-targets.json.genie.ts'

export default projectionArtifact.json({
  schemaVersion: 1,
  data: productionHelpers(cacheTargets.data),
  project: (inventory) => ({ schema: 'effect-utils/production-helpers/v1', ...inventory }),
})
