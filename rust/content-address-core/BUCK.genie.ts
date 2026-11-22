import { withQuickContractSources } from '../../genie/buck2/quick-contract-inputs.ts'
import { cargoBuck2PackageProjection } from '../buck2-tools/core/cargo-buck2-package-projection.ts'

export default withQuickContractSources(
  cargoBuck2PackageProjection({
    sourceUrl: import.meta.url,
    buildProducts: [{ kind: 'library', name: 'content-address-core' }],
  }),
  import.meta.url,
)
