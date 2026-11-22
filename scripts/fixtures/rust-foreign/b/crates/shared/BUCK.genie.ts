import { withQuickContractSources } from '../../../../../../genie/buck2/quick-contract-inputs.ts'
import { providerProjection } from '../../../projection.ts'

export default withQuickContractSources(providerProjection({ sourceUrl: import.meta.url }), import.meta.url)
