import { cargoBuck2PackageProjection } from '../buck2-tools/core/cargo-buck2-package-projection.ts'

export default cargoBuck2PackageProjection({
  sourceUrl: import.meta.url,
  buildProducts: [{ kind: 'library', name: 'content-address-core' }],
})
