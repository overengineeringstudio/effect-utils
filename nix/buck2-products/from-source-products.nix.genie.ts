import { readFileSync } from 'node:fs'

import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

const manifest = JSON.parse(readFileSync('nix/buck2-products/manifest.json', 'utf8')) as {
  readonly products: readonly (
    | {
        readonly descriptor: {
          readonly modulePath: string
          readonly productName: string
          readonly target: string
        }
      }
    | {
        readonly artifactUrl: string
        readonly name: string
        readonly provenance: { readonly target: string }
        readonly version: string
      }
  )[]
}

const packageProducts = [
  '@overeng/content-address',
  '@overeng/effect-distributed-lock',
  '@overeng/notion-core',
  '@overeng/notion-effect-client',
  '@overeng/notion-effect-schema',
  '@overeng/otel-contract',
  '@overeng/tui-core',
  '@overeng/tui-react',
  '@overeng/utils',
  '@overeng/utils-dev',
] as const

const packageEntries = packageProducts.map((name) => {
  const packagePath = `packages/${name}`
  const packageJson = JSON.parse(readFileSync(`${packagePath}/package.json`, 'utf8')) as {
    readonly version: string
  }
  return {
    kind: 'package',
    name,
    outputName: `${name.replace('@', '').replace('/', '-')}.tgz`,
    packagePath,
    packageTreePath: packagePath,
    target: `effect_utils//${packagePath}:dist-package`,
    version: packageJson.version,
  } as const
})
export const buckProductSourceEntries = [
  ...manifest.products.map((publishedProduct) => {
    const target =
      'descriptor' in publishedProduct
        ? publishedProduct.descriptor.target
        : publishedProduct.provenance.target
    const name =
      'descriptor' in publishedProduct
        ? publishedProduct.descriptor.productName
        : publishedProduct.name
    const match = /^effect_utils\/\/(packages\/[^:]+):/.exec(target)
    if (match === null) throw new Error(`Unsupported product target: ${target}`)
    return {
      kind: 'javascript',
      name,
      outputName:
        'descriptor' in publishedProduct
          ? publishedProduct.descriptor.modulePath
          : publishedProduct.artifactUrl.split('/').at(-1)!,
      packagePath: match[1],
      packageTreePath:
        name === 'notion-db-runtime' ? 'packages/@overeng/notion-datasource-sync' : match[1],
      target,
      version: 'descriptor' in publishedProduct ? '0.0.0' : publishedProduct.version,
    } as const
  }),
  ...packageEntries,
].toSorted((left, right) => left.name.localeCompare(right.name))

const nixString = (value: string): string => JSON.stringify(value)

export default createGenieOutput({
  data: buckProductSourceEntries,
  stringify: () =>
    `${[
      '{',
      '  mkBuckProductFromSource,',
      '  preparedDeps,',
      '  producerCommit,',
      '  repositoryRoot ? ../..,',
      '}:',
      '',
      '{',
      ...buckProductSourceEntries.flatMap((entry) => [
        `  ${nixString(entry.name)} = mkBuckProductFromSource {`,
        '    product = {',
        `      kind = ${nixString(entry.kind)};`,
        `      name = ${nixString(entry.name)};`,
        `      outputName = ${nixString(entry.outputName)};`,
        `      packagePath = ${nixString(entry.packagePath)};`,
        `      packageTreePath = ${nixString(entry.packageTreePath)};`,
        `      target = ${nixString(entry.target)};`,
        `      version = ${nixString(entry.version)};`,
        '    };',
        '    inherit preparedDeps;',
        '    inherit producerCommit repositoryRoot;',
        '  };',
      ]),
      '}',
    ].join('\n')}\n`,
})
