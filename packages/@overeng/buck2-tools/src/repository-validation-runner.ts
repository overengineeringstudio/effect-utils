import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
/** Rejects package-local Rust toolchains that would shadow the repository authority. */
export const checkRustToolchainShadows = ({
  sourceRoot,
  memberPaths,
}: {
  readonly sourceRoot: string
  readonly memberPaths: readonly string[]
}): void => {
  if (existsSync(path.join(sourceRoot, 'rust-toolchain.toml')) === false) {
    throw new Error('repository rust-toolchain.toml is missing')
  }
  for (const memberPath of memberPaths) {
    if (existsSync(path.join(sourceRoot, memberPath, 'rust-toolchain.toml')) === true) {
      throw new Error(`${memberPath} shadows the repository Rust toolchain`)
    }
  }
}

type ValidationMode =
  | 'devenv-trace-audit'
  | 'genie-import-closure'
  | 'nix-source'
  | 'workspace-contract'

type WorkspaceManifest = {
  readonly declaredPackages: readonly string[]
}

const requireRecord = (
  ...[value, field]: readonly [value: unknown, field: string]
): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true) {
    throw new Error(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

const requireString = (...[value, field]: readonly [value: unknown, field: string]): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`)
  }
  return value
}

const requireStrings = (
  ...[value, field]: readonly [value: unknown, field: string]
): readonly string[] => {
  if (Array.isArray(value) === false || value.some((entry) => typeof entry !== 'string') === true) {
    throw new Error(`${field} must be an array of strings`)
  }
  return value
}

const requireExactFields = ({
  value,
  fields,
  subject,
}: {
  readonly value: Readonly<Record<string, unknown>>
  readonly fields: readonly string[]
  readonly subject: string
}): void => {
  const actual = Object.keys(value).toSorted()
  const expected = [...fields].toSorted()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${subject} fields must be exactly ${expected.join(', ')}`)
  }
}

const requireUnique = (
  ...[values, subject]: readonly [values: readonly string[], subject: string]
): void => {
  if (new Set(values).size !== values.length) throw new Error(`${subject} must be unique`)
}

const sorted = (values: Iterable<string>): readonly string[] =>
  [...values].toSorted((left, right) => left.localeCompare(right))

const readJson = (
  ...[sourceRoot, relativePath]: readonly [sourceRoot: string, relativePath: string]
): unknown => JSON.parse(readFileSync(path.join(sourceRoot, relativePath), 'utf8'))

const sourcePath = (
  ...[sourceRoot, relativePath]: readonly [sourceRoot: string, relativePath: string]
): string => {
  if (path.isAbsolute(relativePath) === true || relativePath.split('/').includes('..') === true) {
    throw new Error(`validation source path must be normalized and relative: ${relativePath}`)
  }
  return path.join(sourceRoot, relativePath)
}

const run = ({
  command,
  args,
  cwd,
  env,
}: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
}): void => {
  const child = Bun.spawnSync({
    cmd: [command, ...args],
    cwd,
    env: env === undefined ? process.env : { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if (child.exitCode !== 0) process.exit(child.exitCode)
}

const checkDevenvTraceAudit = ({
  sourceRoot,
  sourcePaths,
}: {
  readonly sourceRoot: string
  readonly sourcePaths: readonly string[]
}): { readonly checkedFiles: number } => {
  const governedPaths = sourcePaths.filter(
    (relativePath) =>
      relativePath === 'devenv.nix' ||
      /^nix\/devenv-modules\/tasks\/(?:local|shared)\/.*\.nix$/u.test(relativePath),
  )
  if (governedPaths.length === 0) throw new Error('devenv trace audit received no governed files')

  const bypasses: string[] = []
  for (const relativePath of governedPaths) {
    const lines = readFileSync(sourcePath(sourceRoot, relativePath), 'utf8').split('\n')
    for (const [index, line] of lines.entries()) {
      if (/^\s*(?:exec|status) = /u.test(line) === false) continue
      if (
        /trace[.](?:exec|status)|exec = null|exec = if hasPackages then null else trace[.]exec|trace[.]withStatus/u.test(
          line,
        ) === true
      )
        continue
      const previous = index === 0 ? '' : lines[index - 1]!
      if (`${previous}\n${line}`.includes('trace-audit-allow') === true) continue
      bypasses.push(`${relativePath}:${index + 1}:${line.trim()}`)
    }
  }
  if (bypasses.length > 0) {
    throw new Error(
      `Found task exec/status scripts that bypass the trace.nix task span:\n${bypasses
        .map((bypass) => `BYPASS: ${bypass}`)
        .join('\n')}`,
    )
  }
  return { checkedFiles: governedPaths.length }
}

const parseToolArguments = (values: readonly string[]): ReadonlyMap<string, string> => {
  const tools = new Map<string, string>()
  for (const value of values) {
    const separator = value.indexOf('=')
    if (separator <= 0 || separator === value.length - 1) {
      throw new Error(`--tool must be NAME=PATH: ${value}`)
    }
    const name = value.slice(0, separator)
    tools.set(name, path.resolve(value.slice(separator + 1)))
  }
  return tools
}

const checkNixSource = ({
  sourceRoot,
  sourcePaths,
  tools,
}: {
  readonly sourceRoot: string
  readonly sourcePaths: readonly string[]
  readonly tools: ReadonlyMap<string, string>
}): { readonly checkedFiles: number } => {
  const nixPaths = sorted(sourcePaths.filter((relativePath) => relativePath.endsWith('.nix')))
  if (nixPaths.length === 0) throw new Error('Nix source check received no .nix files')
  const absolutePaths = nixPaths.map((relativePath) => sourcePath(sourceRoot, relativePath))
  run({
    command: requireString(tools.get('nixfmt'), 'nixfmt tool'),
    args: ['--check', ...absolutePaths],
    cwd: sourceRoot,
  })
  run({
    command: requireString(tools.get('deadnix'), 'deadnix tool'),
    args: absolutePaths,
    cwd: sourceRoot,
  })
  return { checkedFiles: nixPaths.length }
}

const checkWorkspaceContract = ({
  sourceRoot,
  manifest,
  tools,
}: {
  readonly sourceRoot: string
  readonly manifest: WorkspaceManifest
  readonly tools: ReadonlyMap<string, string>
}): {
  readonly cargoMembers: number
  readonly nativeProducts: number
  readonly workspacePackages: number
} => {
  const rootPackage = requireRecord(readJson(sourceRoot, 'package.json'), 'package.json')
  const packageWorkspaces = sorted(
    requireStrings(rootPackage.workspaces, 'package.json.workspaces'),
  )
  const workspaceYaml = requireRecord(
    Bun.YAML.parse(readFileSync(path.join(sourceRoot, 'pnpm-workspace.yaml'), 'utf8')),
    'pnpm-workspace.yaml',
  )
  const pnpmWorkspaces = sorted(
    requireStrings(workspaceYaml.packages, 'pnpm-workspace.yaml.packages'),
  )
  const declaredPackages = sorted(manifest.declaredPackages)
  for (const [field, actual] of [
    ['pnpm-workspace.yaml packages', pnpmWorkspaces],
    ['Buck declared packages', declaredPackages],
  ] as const) {
    if (JSON.stringify(actual) !== JSON.stringify(packageWorkspaces)) {
      throw new Error(`${field} disagree with package.json workspaces`)
    }
  }

  const packageNames = new Map<string, string>()
  for (const packagePath of packageWorkspaces) {
    for (const required of [
      'package.json',
      'package.json.genie.ts',
      'tsconfig.json',
      'BUCK',
      'BUCK.genie.ts',
    ]) {
      if (existsSync(path.join(sourceRoot, packagePath, required)) === false) {
        throw new Error(`${packagePath} is missing ${required}`)
      }
    }
    const packageManifest = requireRecord(
      readJson(sourceRoot, `${packagePath}/package.json`),
      `${packagePath}/package.json`,
    )
    const name = requireString(packageManifest.name, `${packagePath}/package.json.name`)
    const prior = packageNames.get(name)
    if (prior !== undefined)
      throw new Error(`workspace package name ${name} is duplicated by ${prior} and ${packagePath}`)
    packageNames.set(name, packagePath)
  }

  const cargoWorkspace = requireRecord(
    Bun.TOML.parse(readFileSync(path.join(sourceRoot, 'rust/Cargo.toml'), 'utf8')),
    'rust/Cargo.toml',
  )
  const workspace = requireRecord(cargoWorkspace.workspace, 'rust/Cargo.toml workspace')
  const workspacePackage = requireRecord(workspace.package, 'rust/Cargo.toml workspace.package')
  for (const [field, expected] of [
    ['version', '0.0.0'],
    ['edition', '2021'],
    ['license', 'MIT'],
  ] as const) {
    if (workspacePackage[field] !== expected) {
      throw new Error(`rust/Cargo.toml workspace.package.${field} must remain ${expected}`)
    }
  }
  const cargoMemberPaths = sorted(
    requireStrings(workspace.members, 'rust/Cargo.toml workspace.members').map((member) =>
      path.posix.normalize(path.posix.join('rust', member)),
    ),
  )
  for (const memberPath of cargoMemberPaths) {
    if (
      path.posix.isAbsolute(memberPath) === true ||
      memberPath === '..' ||
      memberPath.startsWith('../') === true
    ) {
      throw new Error(`Cargo workspace member is outside the repository: ${memberPath}`)
    }
  }
  const cargo = Bun.spawnSync({
    cmd: [
      requireString(tools.get('cargo'), 'cargo tool'),
      'metadata',
      '--manifest-path',
      path.join(sourceRoot, 'rust/Cargo.toml'),
      '--locked',
      '--offline',
      '--no-deps',
      '--format-version',
      '1',
    ],
    cwd: sourceRoot,
    env: { ...process.env, CARGO_NET_OFFLINE: 'true' },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (cargo.exitCode !== 0) {
    throw new Error(`cargo metadata failed:\n${cargo.stderr.toString()}`)
  }
  const cargoMetadata = requireRecord(JSON.parse(cargo.stdout.toString()), 'cargo metadata')
  if (Array.isArray(cargoMetadata.packages) === false) {
    throw new Error('cargo metadata packages must be an array')
  }
  const resolvedCargoPackages = cargoMetadata.packages.map((entry, index) => {
    const packageEntry = requireRecord(entry, `cargo metadata packages[${index}]`)
    const name = requireString(packageEntry.name, `cargo metadata packages[${index}].name`)
    if (
      packageEntry.version !== '0.0.0' ||
      packageEntry.edition !== '2021' ||
      packageEntry.license !== 'MIT'
    ) {
      throw new Error(`${name} does not resolve the shared Cargo package contract`)
    }
    return name
  })
  const expectedCargoPackages = [
    'buck2-archive-tool',
    'buck2-events',
    'buck2-product',
    'buck2-tool-core',
    'effect-rust',
    'effect-rust-fixture-napi',
    'effect-rust-fixture-wasm',
    'effect-rust-macros',
    'hash-core',
    'hash-interop',
    'math-core',
    'math-interop',
    'otel-scrape',
    'otelite',
  ]
  const cargoPackageNames: string[] = []
  for (const memberPath of cargoMemberPaths) {
    const cargoManifest = requireRecord(
      Bun.TOML.parse(readFileSync(path.join(sourceRoot, memberPath, 'Cargo.toml'), 'utf8')),
      `${memberPath}/Cargo.toml`,
    )
    const packageDefinition = requireRecord(
      cargoManifest.package,
      `${memberPath}/Cargo.toml package`,
    )
    cargoPackageNames.push(
      requireString(packageDefinition.name, `${memberPath}/Cargo.toml package.name`),
    )
    const resolvedWorkspace = path.posix.normalize(
      path.posix.join(
        memberPath,
        requireString(packageDefinition.workspace, `${memberPath} package.workspace`),
      ),
    )
    if (resolvedWorkspace !== 'rust') {
      throw new Error(`${memberPath} package.workspace does not resolve to rust/Cargo.toml`)
    }
    for (const field of ['version', 'edition', 'license']) {
      const inherited = requireRecord(packageDefinition[field], `${memberPath} package.${field}`)
      if (inherited.workspace !== true)
        throw new Error(`${memberPath} must inherit package.${field}`)
    }
    for (const required of ['BUCK', 'BUCK.genie.ts']) {
      if (existsSync(path.join(sourceRoot, memberPath, required)) === false) {
        throw new Error(`${memberPath} is missing ${required}`)
      }
    }
  }
  for (const [subject, actual] of [
    ['Cargo workspace', cargoPackageNames],
    ['cargo metadata', resolvedCargoPackages],
  ] as const) {
    if (JSON.stringify(sorted(actual)) !== JSON.stringify(expectedCargoPackages)) {
      throw new Error(`${subject} package census changed without updating the workspace contract`)
    }
  }

  const scrapeManifest = requireRecord(
    Bun.TOML.parse(
      readFileSync(path.join(sourceRoot, 'packages/@overeng/otel-scrape/Cargo.toml'), 'utf8'),
    ),
    'otel-scrape Cargo.toml',
  )
  const scrapeDependencies = requireRecord(scrapeManifest.dependencies, 'otel-scrape dependencies')
  if (scrapeDependencies.libc !== '=0.2.186')
    throw new Error('otel-scrape must keep its exact libc pin')
  const oteliteManifest = requireRecord(
    Bun.TOML.parse(
      readFileSync(path.join(sourceRoot, 'packages/@overeng/otelite/Cargo.toml'), 'utf8'),
    ),
    'otelite Cargo.toml',
  )
  const oteliteTarget = requireRecord(oteliteManifest.target, 'otelite target dependencies')
  const unixDependencies = requireRecord(
    requireRecord(oteliteTarget['cfg(unix)'], 'otelite cfg(unix)').dependencies,
    'otelite cfg(unix) dependencies',
  )
  if (unixDependencies.libc !== '0.2.186') {
    throw new Error('otelite must keep its target-conditioned compatible libc request')
  }

  for (const memberPath of ['packages/@overeng/otel-scrape', 'packages/@overeng/otelite']) {
    const productName = `${path.posix.basename(memberPath)}-product`
    const buck = readFileSync(path.join(sourceRoot, memberPath, 'BUCK'), 'utf8')
    if (buck.includes(`name = "${productName}"`) === false) {
      throw new Error(`${memberPath}/BUCK does not emit ${productName}`)
    }
  }
  for (const memberPath of [
    'rust/buck2-tools/archive-tool',
    'rust/buck2-tools/core',
    'rust/buck2-tools/events',
    'rust/buck2-tools/product',
  ]) {
    const buck = readFileSync(path.join(sourceRoot, memberPath, 'BUCK'), 'utf8')
    if (buck.includes('build_product(') === true)
      throw new Error(`${memberPath}/BUCK must stay product-free`)
  }

  const inventory = requireRecord(
    readJson(sourceRoot, 'nix/buck2-products/native-targets.json'),
    'native product targets',
  )
  requireExactFields({
    value: inventory,
    fields: ['products', 'schema', 'schemaVersion'],
    subject: 'native product targets',
  })
  if (inventory.schema !== 'effect-utils/buck-native-targets/v1' || inventory.schemaVersion !== 1)
    throw new Error('native product target schema changed')
  if (Array.isArray(inventory.products) === false)
    throw new Error('native products must be an array')

  const nativeProducts = inventory.products.map((rawEntry, index) => {
    const entry = requireRecord(rawEntry, `native products[${index}]`)
    const name = requireString(entry.name, `native products[${index}].name`)
    const rust = name === 'otelite' || name === 'otel-scrape'
    requireExactFields({
      value: entry,
      fields: [
        'kind',
        'name',
        'outputName',
        'target',
        'version',
        ...(rust === true ? ['cargoWorkspaceRoot'] : []),
      ],
      subject: `native products[${index}]`,
    })
    const target = requireString(entry.target, `native products[${index}].target`)
    const packagePath = rust === true ? name : 'genie'
    if (
      entry.kind !== 'native' ||
      entry.outputName !== 'artifact.tar' ||
      entry.version !== '0.0.0' ||
      (rust === true && entry.cargoWorkspaceRoot !== 'rust') ||
      target !== `effect_utils//packages/@overeng/${packagePath}:${name}-product`
    ) {
      throw new Error(`native products[${index}] does not match its Buck target`)
    }
    return name
  })
  requireUnique(nativeProducts, 'native products')
  if (
    JSON.stringify(sorted(nativeProducts)) !==
    JSON.stringify(['otel-scrape', 'otelite', 'typescript-api-server'])
  )
    throw new Error('native product target census changed')

  checkRustToolchainShadows({ sourceRoot, memberPaths: cargoMemberPaths })

  return {
    cargoMembers: cargoMemberPaths.length,
    nativeProducts: nativeProducts.length,
    workspacePackages: packageWorkspaces.length,
  }
}

const main = async (): Promise<void> => {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      checker: { type: 'string' },
      manifest: { type: 'string' },
      mode: { type: 'string' },
      output: { type: 'string' },
      path: { type: 'string', multiple: true },
      server: { type: 'string' },
      source: { type: 'string' },
      tool: { type: 'string', multiple: true },
    },
    strict: true,
  })
  const mode = values.mode as ValidationMode | undefined
  if (
    mode !== 'devenv-trace-audit' &&
    mode !== 'genie-import-closure' &&
    mode !== 'nix-source' &&
    mode !== 'workspace-contract'
  ) {
    throw new Error(`unsupported repository validation mode: ${String(mode)}`)
  }
  const output = requireString(values.output, '--output')
  const sourceRoot = path.resolve(requireString(values.source, '--source'))
  const sourcePaths = values.path ?? []
  const tools = parseToolArguments(values.tool ?? [])
  let summary: Readonly<Record<string, unknown>>

  if (mode === 'nix-source') {
    summary = checkNixSource({
      sourceRoot,
      sourcePaths,
      tools,
    })
  } else if (mode === 'devenv-trace-audit') {
    summary = checkDevenvTraceAudit({ sourceRoot, sourcePaths })
  } else if (mode === 'genie-import-closure') {
    const analysisFiles = sourcePaths.filter((relativePath) =>
      /\.(?:[cm]?[jt]sx?)$/u.test(relativePath),
    )
    run({
      command: process.execPath,
      args: [
        path.resolve(requireString(values.checker, '--checker')),
        '--root',
        sourceRoot,
        '--analysis-files',
        JSON.stringify(analysisFiles),
      ],
      cwd: sourceRoot,
      env: {
        GENIE_TYPESCRIPT_API_SERVER: path.resolve(requireString(values.server, '--server')),
      },
    })
    summary = { checked: true }
  } else {
    if (values.manifest === undefined) throw new Error('workspace-contract requires --manifest')
    const decoded = requireRecord(await Bun.file(values.manifest).json(), 'workspace manifest')
    summary = checkWorkspaceContract({
      sourceRoot,
      manifest: {
        declaredPackages: requireStrings(decoded.declaredPackages, 'manifest.declaredPackages'),
      },
      tools,
    })
  }

  await Bun.write(
    output,
    `${JSON.stringify(
      { schema: 'effect-utils/repository-validation/v1', mode, status: 'passed', ...summary },
      null,
      2,
    )}\n`,
  )
}

if (import.meta.main) await main()
