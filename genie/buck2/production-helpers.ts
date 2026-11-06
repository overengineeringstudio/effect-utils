import { posix } from 'node:path'

import {
  inputExistsSync as existsSync,
  inputReadFileSync as readFileSync,
  inputReaddirSync as readdirSync,
} from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'
import { buck2StagedRuntimes } from './runtime-modules.ts'

export const helperRoot = 'packages/@overeng/buck2-tools'
const helperName = '@overeng/buck2-tools'
const productionModule = (file: string): boolean =>
  /\.(?:[cm]?[jt]sx?)$/.test(file) && !/(?:\.test\.|\.stories\.|\.genie\.|\.d\.ts$)/.test(file)
const specifiers = (source: string): readonly string[] =>
  [...source.matchAll(/(?:from|import|new URL)\s*\(?\s*['"]([^'"]+)['"]/gu)].map((match) => match[1]!)

const resolveModule = (file: string): string => {
  const candidates = [file, file.replace(/\.js$/, '.ts')]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (found === undefined) throw new Error(`Missing production helper module: ${file}`)
  if (!productionModule(found)) throw new Error(`Non-production helper module: ${found}`)
  return found
}
const exports = JSON.parse(readFileSync(`${helperRoot}/package.json`, 'utf8')).exports
const exportModule = (specifier: string): string => {
  const key = specifier === helperName ? '.' : `.${specifier.slice(helperName.length)}`
  const entry = exports[key]
  const target = typeof entry === 'string' ? entry : entry?.default ?? entry?.import
  if (typeof target !== 'string' || !target.startsWith('./')) {
    throw new Error(`Missing production helper export: ${specifier}`)
  }
  return resolveModule(posix.join(helperRoot, target))
}

export const applicationHelperEntries = (source: string): readonly string[] =>
  specifiers(source).filter((specifier) =>
    specifier === helperName || specifier.startsWith(`${helperName}/`),
  ).map(exportModule)

/** Literal imports/re-exports and URL preloads are also checked by the runtime closure suite. */
export const helperImportClosure = (entries: readonly string[]): readonly string[] => {
  const seen = new Set<string>()
  const pending = [...entries]
  while (pending.length > 0) {
    const module = resolveModule(pending.pop()!)
    if (seen.has(module)) continue
    seen.add(module)
    for (const specifier of specifiers(readFileSync(module, 'utf8'))) {
      if (specifier.startsWith('.')) pending.push(posix.join(posix.dirname(module), specifier))
      else if (specifier === helperName || specifier.startsWith(`${helperName}/`)) {
        pending.push(exportModule(specifier))
      } else if (specifier.startsWith('@overeng/')) {
        throw new Error(`Undeclared workspace dependency in production helper ${module}: ${specifier}`)
      }
    }
  }
  return [...seen].toSorted()
}

/** Product workspace directories come from the existing committed cache inventory projection. */
export const productionHelpers = (
  products: readonly { readonly sourcePaths?: readonly string[] }[],
): { readonly files: readonly string[]; readonly applicationEntries: readonly string[] } => {
  const applicationEntries = new Set<string>()
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = `${directory}/${entry.name}`
      if (entry.isDirectory()) {
        if (!['node_modules', 'dist', 'fixtures', 'stories', '.editor-view'].includes(entry.name)) walk(file)
      } else if (entry.isFile() && productionModule(file)) {
        for (const entry of applicationHelperEntries(readFileSync(file, 'utf8'))) {
          applicationEntries.add(entry)
        }
      }
    }
  }
  const roots = new Set(products.flatMap((product) => product.sourcePaths ?? []))
  for (const root of roots) if (root.startsWith('packages/') && root !== helperRoot) walk(root)
  const modules = helperImportClosure([
    ...buck2StagedRuntimes.flatMap((runtime) => runtime.modules),
    ...applicationEntries,
  ])
  return {
    files: [`${helperRoot}/package.json`, `${helperRoot}/tsconfig.json`, ...modules].toSorted(),
    applicationEntries: [...applicationEntries].toSorted(),
  }
}

export const helperBuckBlocks = (source: string): readonly string[] =>
  [...source.matchAll(/^[a-z_]+\(\n[\s\S]*?^\]?\)\n/gm)].map((match) => match[0])

/** Copy development declarations verbatim, filtering only their source collections. */
export const productionHelperBuck = (source: string, files: readonly string[]): string => {
  const names = new Set([
    'package.json', 'node_modules', 'package_tree', 'product_package_tree',
    ...buck2StagedRuntimes.flatMap((runtime) => {
      const name = runtime.label.split(':').at(-1)!
      return 'nodeModules' in runtime ? [name, `${name}_files`] : [name]
    }),
  ])
  const declarations = helperBuckBlocks(source).filter((block) => {
    if (block.startsWith('export_materialization_inputs(')) return true
    const name = /\n    name = "([^"]+)",/.exec(block)?.[1]
    return name !== undefined && names.delete(name)
  })
  if (names.size > 0) throw new Error(`Missing production helper targets: ${[...names].join(', ')}`)
  const filter = (block: string): string => block.split('\n').filter((line) => {
    const file = /^\s+"(src\/[^"\n]+|tsconfig\.json)"(?:\s*:.*)?,$/.exec(line)?.[1]
    return file === undefined || files.includes(`${helperRoot}/${file}`)
  }).join('\n')
  return `${source.split('\n').filter((line) => line.startsWith('load(')).join('\n')}\n\n${declarations.map(filter).join('\n')}`
}
