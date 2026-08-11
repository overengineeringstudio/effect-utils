import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createGenieOutput } from '../genie/src/runtime/core.ts'

const packageRoot = fileURLToPath(new URL('./', import.meta.url))
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
const extensions = new Set(['.cts', '.mts', '.ts', '.tsx'])
const excluded = (path: string): boolean =>
  path.includes('/stories/') ||
  path.includes('/test-utils/') ||
  path.endsWith('.test.ts') ||
  path.endsWith('.test.tsx') ||
  path.endsWith('.stories.ts') ||
  path.endsWith('.stories.tsx') ||
  path.endsWith('prompt-select-pty-fixture.ts')

const discover = (directory: string): readonly string[] => {
  const sources: string[] = []
  const walk = (relative: string): void => {
    for (const entry of readdirSync(join(packageRoot, relative), { withFileTypes: true }).toSorted(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      if (entry.isSymbolicLink() === true)
        throw new Error(`Refusing source symlink: ${relative}/${entry.name}`)
      const path = posix.join(relative, entry.name)
      if (entry.isDirectory() === true) walk(path)
      else if (
        entry.isFile() === true &&
        extensions.has(extname(entry.name)) === true &&
        excluded(path) === false
      ) {
        sources.push(path)
      }
    }
  }
  walk(directory)
  return sources
}

const sources = [...discover('bin'), ...discover('src'), 'package.json', 'tsconfig.json'].toSorted()
const checkWorkspaceSources = [
  '//packages/@overeng:content-address_production_sources',
  '//packages/@overeng:effect-distributed-lock_production_sources',
  '//packages/@overeng:effect-path_production_sources',
  '//packages/@overeng:kdl-effect_production_sources',
  '//packages/@overeng:kdl_production_sources',
  '//packages/@overeng:otel-contract_production_sources',
  '//packages/@overeng:tui-react_production_sources',
  '//packages/@overeng:utils-dev_production_sources',
  '//packages/@overeng:utils_production_sources',
  '//packages/@overeng/tui-core:production_sources',
] as const
const checkWorkspaceSourcePrefixes = Object.fromEntries(
  checkWorkspaceSources.map((label) => [
    label,
    label === '//packages/@overeng/tui-core:production_sources'
      ? 'packages/@overeng/tui-core'
      : 'packages/@overeng',
  ]),
)

const runtimeAnalyzer = process.env.BUCK2_RUNTIME_ANALYZER_BUN
if (
  runtimeAnalyzer === undefined ||
  runtimeAnalyzer.startsWith('/nix/store/') === false ||
  runtimeAnalyzer
    .split('/')
    .some((part, index) => index > 2 && (part === '' || part === '.' || part === '..')) === true
)
  throw new Error('BUCK2_RUNTIME_ANALYZER_BUN must be a canonical executable under /nix/store')

const analyzerEnvironment = (home: string): NodeJS.ProcessEnv => ({
  DEVENV_TASK_PASSTHROUGH: '1',
  HOME: home,
  PATH: '/nonexistent',
})

const analyzeRuntimeSources = (): {
  readonly analyzerVersion: string
  readonly sourcesByPackage: Readonly<Record<string, readonly string[]>>
} => {
  const temporary = mkdtempSync(join(tmpdir(), 'megarepo-buck-runtime-inputs-'))
  const metafile = join(temporary, 'metafile.json')
  try {
    const analyzerVersionResult = spawnSync(runtimeAnalyzer, ['--version'], {
      encoding: 'utf8',
      env: analyzerEnvironment(temporary),
    })
    if (analyzerVersionResult.status !== 0)
      throw new Error(`Bun analyzer identity failed:\n${analyzerVersionResult.stderr}`)
    const analyzerVersion = analyzerVersionResult.stdout.trim()
    if (analyzerVersion.length === 0) throw new Error('Bun analyzer reported an empty version')
    const result = spawnSync(
      runtimeAnalyzer,
      [
        'build',
        'bin/mr.ts',
        '--target=bun',
        '--external=@opentui/core-*',
        `--metafile=${metafile}`,
        `--outdir=${join(temporary, 'out')}`,
      ],
      {
        cwd: packageRoot,
        encoding: 'utf8',
        env: analyzerEnvironment(temporary),
        maxBuffer: 128 * 1024 * 1024,
      },
    )
    if (result.status !== 0) {
      throw new Error(`Bun runtime input analysis failed:\n${result.stderr}`)
    }
    const parsed = JSON.parse(readFileSync(metafile, 'utf8')) as {
      readonly inputs: Readonly<Record<string, unknown>>
    }
    const packages = new Map<string, Set<string>>()
    const add = ({
      packageName,
      source,
    }: {
      readonly packageName: string
      readonly source: string
    }): void => {
      const current = packages.get(packageName) ?? new Set<string>()
      current.add(source)
      packages.set(packageName, current)
    }
    for (const input of Object.keys(parsed.inputs)) {
      if (input.startsWith('bin/') === true || input.startsWith('src/') === true)
        add({ packageName: 'megarepo', source: input })
      else if (input.includes('/node_modules/') === true) continue
      else {
        const match = /^\.\.\/([^/]+)\/(src\/.*)$/u.exec(input)
        if (match !== null) add({ packageName: match[1]!, source: match[2]! })
        else throw new Error(`Unclassified first-party Bun runtime input: ${input}`)
      }
    }
    return {
      analyzerVersion,
      sourcesByPackage: Object.fromEntries(
        [...packages.entries()]
          .map(([packageName, packageSources]) => [
            packageName,
            [...packageSources, 'package.json'].toSorted(),
          ])
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ),
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

const runtimeAnalysis = analyzeRuntimeSources()
export const megarepoRuntimeSourcesByPackage = runtimeAnalysis.sourcesByPackage
export const megarepoRuntimeAnalyzerVersion = runtimeAnalysis.analyzerVersion
export const megarepoRuntimeSemanticFingerprint = createHash('sha256')
  .update(
    JSON.stringify({
      analyzer: { name: 'bun', version: megarepoRuntimeAnalyzerVersion },
      flakeLockSha256: createHash('sha256')
        .update(readFileSync(join(repoRoot, 'flake.lock')))
        .digest('hex'),
      pnpmLockSha256: createHash('sha256')
        .update(readFileSync(join(repoRoot, 'pnpm-lock.yaml')))
        .digest('hex'),
      sourcesByPackage: megarepoRuntimeSourcesByPackage,
    }),
  )
  .digest('hex')
const runtimeSources = megarepoRuntimeSourcesByPackage.megarepo ?? []
const runtimeWorkspaceSources = Object.keys(megarepoRuntimeSourcesByPackage)
  .filter((packageName) => packageName !== 'megarepo')
  .map((packageName) =>
    packageName === 'tui-core'
      ? '//packages/@overeng/tui-core:megarepo_runtime_sources'
      : `//packages/@overeng:${packageName}_megarepo_runtime_sources`,
  )
  .toSorted()
const runtimeWorkspaceSourcePrefixes = Object.fromEntries(
  runtimeWorkspaceSources.map((label) => [
    label,
    label.includes('/tui-core:') === true ? 'packages/@overeng/tui-core' : 'packages/@overeng',
  ]),
)

const renderList = (values: readonly string[]): string =>
  values.map((value) => `        ${JSON.stringify(value)},`).join('\n')

const rendered = `load("//buck2:typescript.bzl", "typescript_cli", "typescript_project_check")

# Runtime closure analyzer: bun ${megarepoRuntimeAnalyzerVersion}, pinned by flake.lock
# Runtime closure semantic fingerprint: sha256:${megarepoRuntimeSemanticFingerprint}
# Semantic inputs: flake.lock, pnpm-lock.yaml, and the exact Bun metafile source census

filegroup(
    name = "production_sources",
    srcs = [
${renderList(sources)}
    ],
    visibility = ["PUBLIC"],
)

typescript_project_check(
    name = "typecheck",
    package_path = "packages/@overeng/megarepo",
    platform = "x86_64-linux",
    tsconfig = "packages/@overeng/megarepo/tsconfig.json",
    srcs = [
${renderList(sources)}
    ],
    workspace_sources = [
${renderList(checkWorkspaceSources)}
    ],
    workspace_source_prefixes = {
${Object.entries(checkWorkspaceSourcePrefixes)
  .map(([label, prefix]) => `        ${JSON.stringify(label)}: ${JSON.stringify(prefix)},`)
  .join('\n')}
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
    validation = ":typecheck",
    workspace_sources = [
${renderList(runtimeWorkspaceSources)}
    ],
    workspace_source_prefixes = {
${Object.entries(runtimeWorkspaceSourcePrefixes)
  .map(([label, prefix]) => `        ${JSON.stringify(label)}: ${JSON.stringify(prefix)},`)
  .join('\n')}
    },
)
`

export default createGenieOutput({
  data: {
    checkWorkspaceSourcePrefixes,
    checkWorkspaceSources,
    runtimeSources: megarepoRuntimeSourcesByPackage,
    runtimeWorkspaceSourcePrefixes,
    runtimeWorkspaceSources,
    runtimeAnalyzerVersion: megarepoRuntimeAnalyzerVersion,
    runtimeSemanticFingerprint: megarepoRuntimeSemanticFingerprint,
    sources,
  },
  stringify: () => rendered,
})
