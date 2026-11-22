import { withQuickContractSources } from './genie/buck2/quick-contract-inputs.ts'
import { rootBuckAggregateProjection } from './genie/buck2/root-aggregate-projection.ts'

export default withQuickContractSources(rootBuckAggregateProjection(), import.meta.url)
