import { javaScriptProductRegistry } from '../../genie/buck2/javascript-product-registry.ts'
import { productBuildCapabilities } from '../../genie/buck2/product-capabilities.ts'
import { projectBuckProductSourcePaths } from '../../genie/buck2/product-source-paths.ts'
import ciToolsPkg from '../../packages/@overeng/ci-tools/package.json.genie.ts'
import type { WorkspacePackageLike } from '../../packages/@overeng/genie/src/runtime/package-json/mod.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

const sourcePackages: Record<string, WorkspacePackageLike> = {
  'packages/@overeng/ci-tools': ciToolsPkg,
}

/**
 * Compiled-executable products, one per registry CLI marked `compiledExecutable`.
 * `compiled.nix` imports each per host platform through the native
 * `build_product` path; distribution is Nix substitution of that import, not a
 * cache-manifest row.
 */
const compiledProducts = Object.entries(javaScriptProductRegistry)
  .flatMap(([packagePath, products]) =>
    products.flatMap((product) =>
      'compiledExecutable' in product && product.compiledExecutable === true
        ? [
            {
              kind: 'compiled-executable' as const,
              name: product.productName,
              outputName: 'artifact.tar',
              packagePath,
              target: `effect_utils//${packagePath}:${product.productName}-compiled-product`,
              version: '0.0.0',
            },
          ]
        : [],
    ),
  )
  .map((product) => {
    const pkg = sourcePackages[product.packagePath]
    if (pkg === undefined) throw new Error(`Missing compiled source inventory for ${product.packagePath}`)
    return {
      ...product,
      buildCapabilities: productBuildCapabilities(product),
      sourcePaths: projectBuckProductSourcePaths({
        pkg,
        additionalPaths: ['packages/@overeng/buck2-tools', 'patches'],
      }),
    }
  })
  .toSorted((left, right) => left.name.localeCompare(right.name))

export default projectionArtifact.json({
  schemaVersion: 1,
  data: compiledProducts,
  project: (products) => ({
    products,
    schema: 'effect-utils/buck-compiled-targets/v1',
  }),
})
