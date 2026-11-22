import { withQuickContractSources } from '../../../genie/buck2/quick-contract-inputs.ts'
import { cargoBuck2PackageProjection } from './cargo-buck2-package-projection.ts'

export default withQuickContractSources(cargoBuck2PackageProjection({ sourceUrl: import.meta.url }), import.meta.url)
