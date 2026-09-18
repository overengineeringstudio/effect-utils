import { javaScriptProductPublications } from '../../genie/buck2/javascript-product-registry.ts'
import { buck2SemanticFingerprint } from '../../genie/buck2/mod.ts'
import {
  projectionArtifact,
  projectionValidators,
} from '../../packages/@overeng/genie/src/runtime/mod.ts'

const generator = 'effect-utils/genie/buck2-javascript-release-targets'
const schemaVersion = 1
const source = 'nix/buck2-products/targets.json.genie.ts'
const semanticInputs = ['genie/buck2/javascript-product-registry.ts', source] as const
const regenerationCommand = 'devenv tasks run genie:run'

const packageProductPublications = [
  {
    label: '//packages/@overeng/content-address:dist-package',
    productName: '@overeng/content-address',
  },
  {
    label: '//packages/@overeng/effect-distributed-lock:dist-package',
    productName: '@overeng/effect-distributed-lock',
  },
  {
    label: '//packages/@overeng/notion-core:dist-package',
    productName: '@overeng/notion-core',
  },
  {
    label: '//packages/@overeng/notion-effect-client:dist-package',
    productName: '@overeng/notion-effect-client',
  },
  {
    label: '//packages/@overeng/notion-effect-schema:dist-package',
    productName: '@overeng/notion-effect-schema',
  },
  {
    label: '//packages/@overeng/otel-contract:dist-package',
    productName: '@overeng/otel-contract',
  },
  {
    label: '//packages/@overeng/utils-dev:dist-package',
    productName: '@overeng/utils-dev',
  },
  {
    label: '//packages/@overeng/utils:dist-package',
    productName: '@overeng/utils',
  },
] as const

const products = [...javaScriptProductPublications, ...packageProductPublications]
  .map(({ label, productName }) => ({
    name: productName,
    target: `effect_utils${label}`,
  }))
  .toSorted((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )
const fingerprint = buck2SemanticFingerprint({
  generator,
  schemaVersion,
  semanticData: products,
})

/**
 * Desired JavaScript product inventory. The publisher consumes this generated
 * projection and remains the sole producer of manifest.json.
 */
export default projectionArtifact.json({
  schemaVersion,
  data: products,
  project: (declaredProducts) => ({
    products: declaredProducts,
    provenance: {
      fingerprint,
      generator,
      regenerationCommand,
      semanticInputs,
      source,
    },
  }),
  validators: [
    projectionValidators.uniqueValues({
      rule: 'buck2-javascript-release-target-unique-name',
      label: 'nix/buck2-products/targets.json',
      values: ({ data }) => data.map(({ name }) => name),
    }),
    projectionValidators.uniqueValues({
      rule: 'buck2-javascript-release-target-unique-label',
      label: 'nix/buck2-products/targets.json',
      values: ({ data }) => data.map(({ target }) => target),
    }),
  ],
})
