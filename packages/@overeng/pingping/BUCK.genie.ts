import { withQuickContractSources } from '../../../genie/buck2/quick-contract-inputs.ts'
import { cargoBuck2PackageProjection } from '../../../rust/buck2-tools/core/cargo-buck2-package-projection.ts'

export default withQuickContractSources(cargoBuck2PackageProjection({
  buildProduct: true,
  cliBuildStamp: true,
  sourceUrl: import.meta.url,
}), import.meta.url)
