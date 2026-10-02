import { cargoBuck2PackageProjection } from '../../buck2-tools/core/cargo-buck2-package-projection.ts'

const projection = cargoBuck2PackageProjection({ sourceUrl: import.meta.url })

export default {
  ...projection,
  stringify: (args: Parameters<typeof projection.stringify>[0]) =>
    `${projection.stringify(args)}\nexport_file(name = "vectors", src = "vectors.json", visibility = ["PUBLIC"])\n`,
}
