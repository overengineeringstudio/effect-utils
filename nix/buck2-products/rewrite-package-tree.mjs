const sourceLoad =
  'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")'
const rewrittenLoad =
  'load("//buck2:materialization.bzl", "export_materialization_inputs", "package_tree", "package_view")'
const sourceOpening = 'package_view(\n    name = "package_tree",\n'
const rewrittenOpening = 'package_tree(\n    name = "package_tree",\n'

const exactlyOneOf = (source, values, description) => {
  const matches = values.filter((value) => source.split(value).length === 2)
  if (matches.length !== 1) throw new Error(`Expected exactly one ${description}`)
  return matches[0]
}

const removeDictionaryAttribute = (block, attribute) => {
  const opening = `    ${attribute} = {\n`
  const start = block.indexOf(opening)
  if (start === -1) return block
  if (block.indexOf(opening, start + opening.length) !== -1) {
    throw new Error(`Expected at most one ${attribute} attribute`)
  }
  const body = block.slice(start + opening.length)
  const closing = body.match(/^    \},(?:\n|$)/mu)
  if (closing === null || closing.index === undefined) {
    throw new Error(`Unterminated ${attribute} attribute`)
  }
  const end = start + opening.length + closing.index + closing[0].length
  return block.slice(0, start) + block.slice(end)
}

export const rewritePackageTree = (input) => {
  let source = input
  const load = exactlyOneOf(source, [sourceLoad, rewrittenLoad], 'materialization load')
  if (load === sourceLoad) source = source.replace(sourceLoad, rewrittenLoad)

  const opening = exactlyOneOf(source, [sourceOpening, rewrittenOpening], 'package_tree declaration')
  const blockStart = source.indexOf(opening)
  const blockEnd = source.indexOf('\n)\n', blockStart)
  if (blockEnd === -1) throw new Error('Unterminated package_tree declaration')

  let block = source.slice(blockStart, blockEnd)
  if (opening === sourceOpening) block = block.replace(sourceOpening, rewrittenOpening)

  const dependencyLine = block
    .split('\n')
    .find((line) => line.startsWith('    dependency_view = "//buck2/dependencies:view_'))
  const nodeModulesLine = '    node_modules = "//:nix_prepared_node_modules",'
  if (dependencyLine !== undefined) {
    if (block.includes(nodeModulesLine)) {
      throw new Error('package_tree declaration has both dependency_view and node_modules')
    }
    block = block.replace(dependencyLine, nodeModulesLine)
  } else if (!block.includes(nodeModulesLine)) {
    throw new Error('package_tree declaration has neither dependency_view nor prepared node_modules')
  }

  block = removeDictionaryAttribute(block, 'workspace_dist')
  block = removeDictionaryAttribute(block, 'workspace_dependency_views')
  return source.slice(0, blockStart) + block + source.slice(blockEnd)
}

if (import.meta.main) {
  const [path, ...rest] = Bun.argv.slice(2)
  if (path === undefined || rest.length !== 0) {
    throw new Error('usage: rewrite-package-tree.mjs PACKAGE_BUCK')
  }
  const source = await Bun.file(path).text()
  await Bun.write(path, rewritePackageTree(source))
}
