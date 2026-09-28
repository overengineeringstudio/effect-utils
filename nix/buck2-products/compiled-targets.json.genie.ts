import { javaScriptProductRegistry } from '../../genie/buck2/javascript-product-registry.ts'
import { projectionArtifact } from '../../packages/@overeng/genie/src/runtime/mod.ts'

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
  .toSorted((left, right) => left.name.localeCompare(right.name))

export default projectionArtifact.json({
  schemaVersion: 1,
  data: compiledProducts,
  project: (products) => ({
    products,
    schema: 'effect-utils/buck-compiled-targets/v1',
  }),
})
