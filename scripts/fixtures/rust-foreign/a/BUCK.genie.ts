import { withQuickContractSources } from '../../../../genie/buck2/quick-contract-inputs.ts'
import { consumerProjection } from '../projection.ts'

export default withQuickContractSources(
  consumerProjection({ sourceUrl: import.meta.url }),
  import.meta.url,
)
