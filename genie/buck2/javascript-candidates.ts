import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'

const quote = (value: string): string => JSON.stringify(value)
const list = (values: readonly string[]): string => `[${values.map(quote).join(', ')}]`

export type JavaScriptProduct = {
  /**
   * Also emit a `compiled-executable` product: the CLI module compiled by
   * `bun build --compile` into `<productName>-compiled-product`, a host-platform
   * `build_product` whose entrypoint is `bin/<productName>`.
   */
  readonly compiledExecutable?: boolean
  readonly entrypoint: string
  readonly external?: readonly string[]
  readonly externalCapabilities?: readonly string[]
  readonly kind: 'cli' | 'module'
  readonly output: string
  readonly packageTree?: string
  readonly productName: string
  readonly runtime?: 'bun' | 'node'
  /** Retained in the producer declaration for package-local runtime checks. */
  readonly smokeArgs?: readonly string[]
  readonly smokeRuntime?: 'bun' | 'node'
  readonly targetName: string
  readonly treeShaking?: boolean
}

export type JavaScriptCandidates = {
  readonly products: readonly JavaScriptProduct[]
}

const renderCompiledExecutable = (product: JavaScriptProduct): string => {
  if (product.kind !== 'cli') {
    throw new Error(`compiled executable ${product.productName} must be a cli product`)
  }
  const executableName = `${product.productName}-compiled-executable`
  return `bun_compiled_product_executable(
    name = ${quote(executableName)},
    module = ${quote(`:${product.targetName}-module`)},
    product_name = ${quote(product.productName)},
    recipe = ${quote(`bun-compile:${product.entrypoint}`)},
    target_platform = host_platform_label(),
)

build_product(
    name = ${quote(`${product.productName}-compiled-product`)},
    entrypoint = ${quote(`bin/${product.productName}`)},
    executable = ${quote(`:${executableName}`)},
    product_name = ${quote(product.productName)},
    target_platform = host_platform_label(),
    visibility = ["PUBLIC"],
)`
}

const renderProduct = (product: JavaScriptProduct): string => {
  const moduleName = `${product.targetName}-module`
  return `package_bin_artifact(
    name = ${quote(moduleName)},
    entrypoint = ${quote(product.entrypoint)},
    external = ${list(product.external ?? [])},
    external_capabilities = ${list(product.externalCapabilities ?? [])},
    kind = ${quote(product.kind)},
    output = ${quote(product.output)},
    package_tree = ${quote(product.packageTree ?? ':package_tree')},
    target = ${quote(product.runtime ?? 'node')},
${product.treeShaking === false ? '    tree_shaking = False,\n' : ''}    visibility = ["PUBLIC"],
)

javascript_product(
    name = ${quote(product.targetName)},
    module = ${quote(`:${moduleName}`)},
    product_kind = ${quote(product.kind)},
    product_name = ${quote(product.productName)},
    visibility = ["PUBLIC"],
)${product.compiledExecutable === true ? `\n\n${renderCompiledExecutable(product)}` : ''}`
}

/**
 * Appends product candidates to a package's canonical TypeScript projection.
 *
 * The wrapped output retains the projection's data and validation hooks, and
 * embeds its serialized graph verbatim. This wrapper owns only the additional
 * product loads and targets; it does not reproduce the normalized dependency
 * or editor-view graph.
 */
export const withJavaScriptCandidates = <TData>({
  projection,
  products,
}: JavaScriptCandidates & { readonly projection: GenieOutput<TData> }): GenieOutput<TData> =>
  createGenieOutput({
    ...projection,
    stringify: (context) => {
      const base = projection.stringify(context)
      if (products.length === 0) return base
      const compiled = products.some((product) => product.compiledExecutable === true)
      return `load("//buck2:package_tools.bzl", "package_bin_artifact")
${
  compiled
    ? `load("//buck2/platforms:defs.bzl", "host_platform_label")
load("//buck2/products:defs.bzl", "build_product", "bun_compiled_product_executable", "javascript_product")`
    : 'load("//buck2/products:defs.bzl", "javascript_product")'
}

${base}
${products.map(renderProduct).join('\n\n')}
`
    },
  })
