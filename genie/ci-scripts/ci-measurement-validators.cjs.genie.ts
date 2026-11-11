import { renderCiMeasurementValidators } from '../../packages/@overeng/genie/src/build/ci-measurements/schema.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

// Commit the dependency-free validators once; workflows load the prepared CI helper copy.
const content = `${renderCiMeasurementValidators()}
module.exports = { isCiMeasurementArtifact, isCiMeasurementComparison, isCiMeasurementCommentState }
`

export default createGenieOutput({ data: content, stringify: () => content })
