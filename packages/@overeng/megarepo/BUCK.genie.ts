import { readdirSync } from 'node:fs'
import { extname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGenieOutput } from '../genie/src/runtime/core.ts'
import { workspaceName, workspacePackages } from './buck2/workspace-packages.ts'
import megarepoPackage from './package.json.genie.ts'
import megarepoTsconfig from './tsconfig.json.genie.ts'

const packageRoot = fileURLToPath(new URL('./', import.meta.url))
const extensions = new Set(['.cts', '.mts', '.ts', '.tsx'])
const compareStrings = ({ left, right }: { left: string; right: string }): number =>
  left < right ? -1 : left > right ? 1 : 0
const excludedFromProduct = (path: string): boolean =>
  path.includes('/stories/') ||
  path.includes('/test-utils/') ||
  path.includes('.test.') ||
  path.includes('.stories.') ||
  path.endsWith('prompt-select-pty-fixture.ts')

const discover = ({
  directory,
  productOnly,
}: {
  directory: string
  productOnly: boolean
}): readonly string[] => {
  const sources: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true }).toSorted(
      (left, right) => compareStrings({ left: left.name, right: right.name }),
    )) {
      if (entry.isSymbolicLink() === true)
        throw new Error(`Refusing source symlink: ${relative}/${entry.name}`)
      const path = posix.join(relative, entry.name)
      if (entry.isDirectory() === true) walk(path)
      else if (
        entry.isFile() === true &&
        extensions.has(extname(entry.name)) === true &&
        (productOnly === false || excludedFromProduct(path) === false)
      )
        sources.push(path)
    }
  }
  walk(directory)
  return sources
}

const checkSources = [
  ...discover({ directory: 'bin', productOnly: false }),
  ...discover({ directory: 'src', productOnly: false }),
  'package.json',
  'tsconfig.json',
].toSorted((left, right) => compareStrings({ left, right }))
const runtimeSources = [
  ...discover({ directory: 'bin', productOnly: true }),
  ...discover({ directory: 'src', productOnly: true }),
  'package.json',
].toSorted((left, right) => compareStrings({ left, right }))
const labelFor = ({ name, role }: { name: string; role: 'production' | 'project' }): string =>
  name === 'tui-core'
    ? `//packages/@overeng/tui-core:${role}_sources`
    : `//packages/@overeng:${name}_${role}_sources`
type TsconfigOutput = {
  readonly data: { readonly references?: readonly { readonly path: string }[] }
}
const referenceNames = (tsconfig: TsconfigOutput): readonly string[] =>
  (tsconfig.data.references ?? []).map(({ path }) => path.replace(/^\.\.\//u, ''))
const projectReferenceNames = (): readonly string[] => {
  const pending = [...referenceNames(megarepoTsconfig)]
  const seen = new Set<keyof typeof workspacePackages>()
  while (pending.length > 0) {
    const referenceName = pending.pop()!
    const name = workspaceName(`@overeng/${referenceName}`)
    if (name === undefined)
      throw new Error(`Unknown workspace tsconfig reference: ${referenceName}`)
    if (seen.has(name) === true) continue
    seen.add(name)
    pending.push(...referenceNames(workspacePackages[name].tsconfig))
  }
  return [...seen]
    .map((name) => name.slice('@overeng/'.length))
    .toSorted((left, right) => compareStrings({ left, right }))
}
const runtimeWorkspacePackageNames = (): readonly string[] => {
  const pending = Object.keys(megarepoPackage.data.dependencies ?? {})
  const seen = new Set<keyof typeof workspacePackages>()
  while (pending.length > 0) {
    const specifier = pending.pop()!
    const name = workspaceName(specifier)
    if (name === undefined) {
      if (specifier.startsWith('@overeng/') === true)
        throw new Error(`Unknown workspace package dependency: ${specifier}`)
      continue
    }
    if (seen.has(name) === true) continue
    seen.add(name)
    pending.push(...Object.keys(workspacePackages[name].packageJson.data.dependencies ?? {}))
  }
  return [...seen].map((name) => name.slice('@overeng/'.length))
}
const checkWorkspaceSources = projectReferenceNames()
  .map((name) => labelFor({ name, role: 'project' }))
  .toSorted((left, right) => compareStrings({ left, right }))
const runtimeWorkspaceSources = runtimeWorkspacePackageNames()
  .map((name) => labelFor({ name, role: 'production' }))
  .toSorted((left, right) => compareStrings({ left, right }))
const prefixForLabel = (label: string): string =>
  label.includes('/tui-core:') === true ? 'packages/@overeng/tui-core' : 'packages/@overeng'
const renderList = (values: readonly string[]): string =>
  values.map((value) => `        ${JSON.stringify(value)},`).join('\n')
const renderPrefixes = (labels: readonly string[]): string =>
  labels
    .map((label) => `        ${JSON.stringify(label)}: ${JSON.stringify(prefixForLabel(label))},`)
    .join('\n')

const rendered = `# Role closures derive from package.json.genie.ts and tsconfig.json.genie.ts.
load("//buck2:typescript.bzl", "typescript_cli", "typescript_project_check")

filegroup(
    name = "production_sources",
    srcs = [
${renderList(runtimeSources)}
    ],
    visibility = ["PUBLIC"],
)

filegroup(
    name = "project_sources",
    srcs = [
${renderList(checkSources)}
    ],
    visibility = ["PUBLIC"],
)

typescript_project_check(
    name = "typecheck",
    package_path = "packages/@overeng/megarepo",
    platform = "x86_64-linux",
    tsconfig = "packages/@overeng/megarepo/tsconfig.json",
    srcs = [
${renderList(checkSources)}
    ],
    workspace_sources = [
${renderList(checkWorkspaceSources)}
    ],
    workspace_source_prefixes = {
${renderPrefixes(checkWorkspaceSources)}
    },
)

typescript_cli(
    name = "mr",
    package_path = "packages/@overeng/megarepo",
    entry = "packages/@overeng/megarepo/bin/mr.ts",
    binary_name = "mr",
    platform = "x86_64-linux",
    srcs = [
${renderList(runtimeSources)}
    ],
    workspace_sources = [
${renderList(runtimeWorkspaceSources)}
    ],
    workspace_source_prefixes = {
${renderPrefixes(runtimeWorkspaceSources)}
    },
)

filegroup(
    name = "mr_quality",
    srcs = [":mr", ":typecheck"],
    visibility = ["PUBLIC"],
)
`

export default createGenieOutput({
  data: { checkSources, checkWorkspaceSources, runtimeSources, runtimeWorkspaceSources },
  stringify: () => rendered,
})
