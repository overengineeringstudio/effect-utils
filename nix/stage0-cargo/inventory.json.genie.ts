import { stage0CargoProjection } from '../../genie/buck2/stage0-cargo.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

export default projectionArtifact.json({
  schemaVersion: 1,
  data: stage0CargoProjection(),
  project: (tools) => ({ schema: 'effect-utils/stage0-cargo/v1', tools }),
})
