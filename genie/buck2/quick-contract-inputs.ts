import path from 'node:path'

import targetCatalog from '../../nix/quick-contracts-targets.json'
import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'
import { inputReadFileSync as readFileSync } from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'
import {
  modulePathFromUrl,
  repoRootFromModuleUrl,
} from '../../packages/@overeng/genie/src/runtime/repo-context/mod.ts'
import {
  contractSourceGroup,
  contractSourceName,
  contractSourceOwners,
  discoverContractPackages,
  renderContractSourceExclusions,
  type ContractSourceGroup,
  type SourceSelection,
} from './quick-contract-source-groups.ts'

type NativeProviders = {
  readonly toolchain: string
  readonly product: string
}
type ContractInputs = SourceSelection & {
  readonly requires: readonly string[]
  readonly cache_policy: string
  readonly cpu_demand?: string
  readonly membership_mode?: string
  readonly native_providers?: NativeProviders
}
type ContractProjection = {
  readonly source_sets: readonly string[]
  readonly requires: readonly string[]
  readonly cache_policy: string
  readonly cpu_demand?: string
  readonly membership: readonly string[]
  readonly membership_mode: 'tracked' | 'tracked-and-untracked'
  readonly native_providers?: NativeProviders
}
const catalog: Readonly<Record<string, ContractInputs>> = targetCatalog
const repoRoot = repoRootFromModuleUrl(import.meta.url)
const { owners, directories } = discoverContractPackages(repoRoot)
const validPath = (value: string): boolean =>
  value !== '' &&
  !path.posix.isAbsolute(value) &&
  path.posix.normalize(value) === value &&
  !value.split('/').some((segment) => segment === '..' || segment === '.') &&
  !/[\[\]*?{}]/.test(value)
const sequenceSource = readFileSync(path.join(repoRoot, 'nix/quick-contracts-sequence.nix'), 'utf8')
const sequenceNames = [
  ...new Set(
    [...sequenceSource.matchAll(/"([a-z][a-z0-9:-]*:[a-z0-9:-]+)"/g)].map((match) => match[1]!),
  ),
].sort()
if (JSON.stringify(sequenceNames) !== JSON.stringify(Object.keys(catalog).sort()))
  throw new Error('Quick contract catalog must exactly cover the sequence host/CI union')

const contractSourceExports: Record<string, Record<string, ContractSourceGroup>> = {}
const contracts: Readonly<Record<string, ContractProjection>> = Object.fromEntries(
  Object.entries(catalog)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, inputs]) => {
      if (!['local-validation', 'local-fixture', 'live-guard'].includes(inputs.cache_policy))
        throw new Error(`${name}: unknown contract cache policy ${inputs.cache_policy}`)
      const cpuDemand = inputs.native_providers === undefined ? inputs.cpu_demand : undefined
      if (inputs.native_providers === undefined) {
        if (
          cpuDemand === undefined ||
          !/^(single-thread|bounded:[1-9][0-9]*|whole-pool)$/.test(cpuDemand)
        )
          throw new Error(
            `${name}: non-native contract requires cpu_demand declared as single-thread, bounded:<cpus>, or whole-pool`,
          )
      } else if (inputs.cpu_demand !== undefined) {
        throw new Error(`${name}: native provider contract stays execution-free; cpu_demand must not be declared`)
      }
      const membershipMode = inputs.membership_mode ?? 'tracked'
      if (membershipMode !== 'tracked' && membershipMode !== 'tracked-and-untracked')
        throw new Error(`${name}: unknown membership mode ${membershipMode}`)
      for (const file of inputs.paths) {
        if (!validPath(file)) throw new Error(`${name}: invalid explicit input ${file}`)
      }
      for (const prefix of inputs.prefixes) {
        if (prefix !== '' && !validPath(prefix.endsWith('/') ? prefix.slice(0, -1) : prefix))
          throw new Error(`${name}: invalid input prefix ${prefix}`)
      }
      for (const dependency of inputs.requires) {
        if (dependency === name || catalog[dependency] === undefined)
          throw new Error(`${name}: unknown or self contract prerequisite ${dependency}`)
      }
      const selectedOwners = contractSourceOwners(inputs, owners, directories)
      for (const owner of selectedOwners) {
        ;(contractSourceExports[owner] ??= {})[name] = contractSourceGroup({
          selection: inputs,
          owner,
          owners,
          directories,
        })
      }
      return [
        name,
        {
          source_sets: selectedOwners.map(
            (owner) => `//${owner === '.' ? '' : owner}:${contractSourceName(name)}`,
          ),
          requires: [...new Set(inputs.requires)].sort(),
          cache_policy: inputs.cache_policy,
          ...(cpuDemand === undefined ? {} : { cpu_demand: cpuDemand }),
          membership: [...new Set(inputs.membership ?? [])].sort(),
          membership_mode: membershipMode,
          ...(inputs.native_providers === undefined
            ? {}
            : { native_providers: inputs.native_providers }),
        },
      ]
    }),
)

export const quickContractInputs = { contracts, owners: contractSourceExports }

/** Buck evaluates live package-local globs, never generation-time file lists. */
export const appendQuickContractSources = (rendered: string, owner: string): string => {
  const groups = contractSourceExports[owner]
  if (groups === undefined) return rendered
  const exclusions = renderContractSourceExclusions(Object.values(groups)[0]!.exclusionAnchors)
  const loadOffset = Math.max(0, rendered.search(/^load\(/m))
  return (
    rendered.slice(0, loadOffset) +
    'load("//buck2:static_checks.bzl", _quick_contract_source_set = "static_source_set")\n' +
    rendered.slice(loadOffset) +
    `
# Package boundaries and hidden-directory anchors are owned by Genie. Regenerate
# owning BUCK files for new packages or deeper hidden-directory chains; Buck has
# no include_dotfiles switch. Existing anchored directories retain live globs.
_quick_contract_source_excludes = ${exclusions}
` +
    Object.entries(groups)
      .map(
        ([task, group]) => `
# Buck hashes these package-local check inputs, independently of product inputs.
_quick_contract_source_set(
    name = ${JSON.stringify(contractSourceName(task))},
    prefix = ${JSON.stringify(owner === '.' ? '' : owner)},
    srcs = glob(${JSON.stringify(group.include, null, 4)}, exclude = _quick_contract_source_excludes),
    visibility = ["PUBLIC"],
)
`,
      )
      .join('')
  )
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

/** One authored base per static package; canonical Genie owns the final BUCK. */
export const quickContractTemplate = (
  sourceUrl: string,
): GenieOutput<{ readonly template: string }> => {
  const template = readFileSync(
    path.join(path.dirname(modulePathFromUrl(sourceUrl)), 'BUCK.template'),
    'utf8',
  )
  return withQuickContractSources(
    createGenieOutput({
      data: { template },
      stringify: () => template,
    }),
    sourceUrl,
  )
}
