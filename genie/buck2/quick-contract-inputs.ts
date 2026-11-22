import { execFileSync } from 'node:child_process'
import path from 'node:path'

import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import {
  inputExistsSync as existsSync,
  inputReaddirSync as readdirSync,
  inputReadFileSync as readFileSync,
  recordInputReason,
} from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'
import {
  modulePathFromUrl,
  repoRootFromModuleUrl,
} from '../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import targetCatalog from '../../nix/quick-contracts-targets.json'

type ContractInputs = {
  readonly paths: readonly string[]
  readonly prefixes: readonly string[]
  readonly requires: readonly string[]
  readonly cache_policy: 'local-validation' | 'local-fixture' | 'live-guard'
  /** Suffixes (including compound extensions) restrict prefix-selected bytes only. */
  readonly extensions?: readonly string[]
  /** Git pathspecs, never inferred from the conservative filesystem census. */
  readonly membership?: readonly string[]
  readonly membership_mode?: 'tracked' | 'tracked-and-untracked'
  /** Guards that read enumerated bytes, unlike membership-only formatter parity. */
  readonly membership_inputs?: boolean
}

type ContractProjection = {
  readonly input_paths: readonly string[]
  readonly source_sets: readonly string[]
  readonly requires: readonly string[]
  readonly cache_policy: ContractInputs['cache_policy']
  readonly membership: readonly string[]
  readonly membership_mode: NonNullable<ContractInputs['membership_mode']>
  readonly members: readonly string[]
}

const authoredCatalog: Readonly<Record<string, Omit<ContractInputs, 'cache_policy'> & {
  readonly cache_policy: string
}>> = targetCatalog
const catalog: Readonly<Record<string, ContractInputs>> = Object.fromEntries(
  Object.entries(authoredCatalog).map(([name, inputs]): readonly [string, ContractInputs] => {
    const policy = inputs.cache_policy
    if (policy !== 'local-validation' && policy !== 'local-fixture' && policy !== 'live-guard') {
      throw new Error(`${name}: unknown contract cache policy ${policy}`)
    }
    return [name, { ...inputs, cache_policy: policy }]
  }),
)
const repoRoot = repoRootFromModuleUrl(import.meta.url)
// Match the workspace source census exclusions, including Cargo output. Do not
// follow editor/dependency symlinks or accidentally admit local execution state.
const excludedDirectories: Readonly<Record<string, true>> = {
  '.cache': true, '.codex': true, '.context': true, '.devenv': true,
  '.direnv': true, '.editor-view': true, '.evergreen': true, '.git': true,
  '.playwright-cli': true, '.playwright-mcp': true, '.pnpm': true,
  '.pnpm-home': true, '.pnpm-store': true, '.vercel': true,
  '.vitest-attachments': true, 'buck-out': true, dist: true,
  'genie-locks': true, node_modules: true, repos: true, result: true,
  'storybook-static': true, target: true, tmp: true,
}
const repositoryFiles: string[] = []
const discover = (directory: string): void => {
  for (const entry of readdirSync(path.join(repoRoot, directory), { withFileTypes: true })) {
    // Existing owning generators write same-directory candidates atomically.
    if (entry.name.startsWith('.BUCK.next.') || entry.name.startsWith('.git-archives.json.next.')) continue
    const relative = path.posix.join(directory, entry.name)
    if (entry.isDirectory() && excludedDirectories[entry.name] === true) continue
    if (entry.isDirectory()) discover(relative)
    else if (entry.isFile()) repositoryFiles.push(relative)
    // Symlinks are never source bytes. Explicit paths below fail closed on them.
  }
}
discover('.')
repositoryFiles.sort()
const fileSet = new Set(repositoryFiles)
const sourceOwners = new Map<string, string>()
// Same nearest-package rule as typescript-package-projection.ts: authored BUCK
// and not-yet-emitted BUCK.genie.ts boundaries both own their source labels.
const sourceOwner = (directory: string): string => {
  const cached = sourceOwners.get(directory)
  if (cached !== undefined) return cached
  const owner =
    directory === '.' ||
    existsSync(path.join(repoRoot, directory, 'BUCK')) ||
    existsSync(path.join(repoRoot, directory, 'BUCK.genie.ts'))
      ? directory
      : sourceOwner(path.posix.dirname(directory))
  sourceOwners.set(directory, owner)
  return owner
}
const validPath = (value: string): boolean =>
  value !== '' && !path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value &&
  !value.split('/').some((segment) => segment === '..' || segment === '.')

// The sequence remains the only selection authority. Read its declared literals
// to validate union coverage; Nix chooses the host/CI branch during preparation.
const sequenceSource = readFileSync(path.join(repoRoot, 'nix/quick-contracts-sequence.nix'), 'utf8')
const sequenceNames = [...new Set([...sequenceSource.matchAll(/"([a-z][a-z0-9:-]*:[a-z0-9:-]+)"/g)].map((match) => match[1]!))].sort()
if (JSON.stringify(sequenceNames) !== JSON.stringify(Object.keys(catalog).sort())) {
  throw new Error('Quick contract catalog must exactly cover the sequence host/CI union')
}

// Expose exact owner-relative export requirements to the owning projections.
// These are individual files, not static_source_set or whole-tree dependencies.
const contractSourceExports: Record<string, string[]> = {}
// Qualify one real contract before scaling input groups to the whole cohort.
const prototypeContract = 'lint:check:getflake'
const membershipCensuses = new Map<string, readonly string[]>()
const contracts: Readonly<Record<string, ContractProjection>> = Object.fromEntries(
  Object.entries(catalog).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  ).map(([name, inputs]): readonly [string, ContractProjection] => {
  for (const file of inputs.paths) {
    if (!validPath(file) || !fileSet.has(file)) {
      throw new Error(`${name}: missing, excluded, or non-file explicit input ${file}`)
    }
  }
  for (const prefix of inputs.prefixes) {
    if (prefix !== '' && !validPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix)) {
      throw new Error(`${name}: invalid input prefix ${prefix}`)
    }
  }
  for (const dependency of inputs.requires) {
    if (dependency === name || catalog[dependency] === undefined) {
      throw new Error(`${name}: unknown or self contract prerequisite ${dependency}`)
    }
  }
  const membership = [...new Set(inputs.membership ?? [])].sort()
  const membershipMode = inputs.membership_mode ?? 'tracked'
  const membershipKey = JSON.stringify([membershipMode, membership])
  let members = membershipCensuses.get(membershipKey)
  if (members === undefined) {
    if (membership.length === 0) members = []
    else {
      // Same read-only Git discovery convention as Genie's core/discovery.ts.
      // Filesystem discovery above is deliberately NOT tracked membership.
      recordInputReason({
        code: 'subprocess',
        operation: 'git discovery',
        detail: 'Quick contract tracked membership uses read-only git ls-files',
        source: { module: 'genie/buck2/quick-contract-inputs.ts', line: null },
        generators: [],
        evidence: 'observed',
      })
      members = [...new Set(execFileSync('git', [
        '-C', repoRoot, 'ls-files', '-z', '--cached',
        ...(membershipMode === 'tracked-and-untracked' ? ['--others', '--exclude-standard'] : []),
        '--', ...membership,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .split('\0').filter((file) => file !== ''))].sort()
    }
    membershipCensuses.set(membershipKey, members)
  }
  const enumeratedInputs = inputs.membership_inputs === true ? members : []
  for (const file of enumeratedInputs) {
    if (!validPath(file) || !fileSet.has(file)) {
      throw new Error(`${name}: enumerated source is missing, excluded, or not a file: ${file}`)
    }
  }
  const files = [...new Set([
    ...inputs.paths,
    ...enumeratedInputs,
    ...repositoryFiles.filter((file) =>
      inputs.prefixes.some((prefix) => file.startsWith(prefix)) &&
      (inputs.extensions === undefined || inputs.extensions.some((suffix) => file.endsWith(suffix))),
    ),
  ])].sort()
  if (files.length === 0) throw new Error(`${name}: contract input projection is empty`)
  if (name === prototypeContract) {
    for (const file of files) {
      const owner = sourceOwner(path.posix.dirname(file))
      const exported = contractSourceExports[owner] ??= []
      exported.push(path.posix.relative(owner, file))
    }
  }
  return [name, {
    input_paths: files,
    source_sets: [...new Set(files.map((file) => {
      const owner = sourceOwner(path.posix.dirname(file))
      return `//${owner === '.' ? '' : owner}:quick_contract_sources`
    }))].sort(),
    requires: [...new Set(inputs.requires)].sort(),
    cache_policy: inputs.cache_policy,
    membership,
    membership_mode: membershipMode,
    members,
  }]
  }),
)
for (const [owner, files] of Object.entries(contractSourceExports)) {
  contractSourceExports[owner] = [...new Set(files)].sort()
}

export const quickContractInputs = { contracts, owners: contractSourceExports }

/** Add the repository-owned provider to a generated Buck load header. */
export const appendQuickContractSources = (rendered: string, owner: string): string => {
  const sources = contractSourceExports[owner]
  if (sources === undefined) return rendered
  const loadOffset = rendered.search(/^load\(/m)
  if (loadOffset < 0) throw new Error(`${owner}: expected generated Buck load header`)
  return rendered.slice(0, loadOffset) +
    'load("//buck2:static_checks.bzl", _quick_contract_source_set = "static_source_set")\n' +
    rendered.slice(loadOffset) + `
_quick_contract_source_set(
    name = "quick_contract_sources",
    prefix = ${JSON.stringify(owner === '.' ? '' : owner)},
    srcs = ${JSON.stringify(sources, null, 4)},
    visibility = ["PUBLIC"],
)
`
}

/** Repository-specific addition; shared TypeScript/Cargo projectors stay reusable. */
export const withQuickContractSources = <TData>(
  projection: GenieOutput<TData>,
  sourceUrl: string,
): GenieOutput<TData> => {
  const owner = path.relative(repoRoot, path.dirname(modulePathFromUrl(sourceUrl))) || '.'
  if (contractSourceExports[owner] === undefined) return projection
  return createGenieOutput({
    ...projection,
    stringify: (context) => appendQuickContractSources(projection.stringify(context), owner),
  })
}
