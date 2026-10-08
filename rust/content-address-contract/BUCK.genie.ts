import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'
import { cargoBuck2PackageProjection } from '../buck2-tools/core/cargo-buck2-package-projection.ts'
import { assertContractGenerationFreshness } from './generation-freshness.ts'

const projection = cargoBuck2PackageProjection({ sourceUrl: import.meta.url })

/** Projects the compiler-emitted crate and exports its authoritative transport schema. */
export default createGenieOutput({
  ...projection,
  stringify: (context) => {
    assertContractGenerationFreshness({ sourceUrl: import.meta.url })
    return `${projection.stringify(context)}\nnative.export_file(\n    name = "contract-schema",\n    src = "schema/ContentDescriptor.json",\n    visibility = ["PUBLIC"],\n)\nnative.export_file(\n    name = "generation-manifest",\n    src = "generation.json",\n    visibility = ["PUBLIC"],\n)\n`
  },
})
