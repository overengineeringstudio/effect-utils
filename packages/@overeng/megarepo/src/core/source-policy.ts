import { Effect, Option } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { type PlatformError } from 'effect/PlatformError'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { getMemberPath, type MegarepoConfig, parseSourceString } from './config.ts'
import type { LockFile, LockedMember } from './lock.ts'
import { getRef, parseNixFlakeUrl, serializeNixFlakeUrl } from './nix-lock/flake-url.ts'
import {
  extractDevenvYamlInputs,
  extractFlakeNixInputs,
  matchUrlToMember,
} from './nix-lock/input-discovery.ts'

/** Files inspected by the GitHub source policy check. */
export type SourcePolicyFile =
  | 'megarepo config'
  | 'flake.nix'
  | 'devenv.yaml'
  | 'flake.lock'
  | 'devenv.lock'

/** A canonical-source policy violation with enough context for CLI output. */
export type SourcePolicyViolation =
  | {
      readonly _tag: 'NonCanonicalGitHubMemberSource'
      readonly file: SourcePolicyFile
      readonly path: string
      readonly memberName: string
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'NonCanonicalNixInputSource'
      readonly file: SourcePolicyFile
      readonly path: string
      readonly inputName: string
      readonly upstreamMember: string
      readonly actual: string
      readonly expected: string
    }
  | {
      readonly _tag: 'IncompleteGitHubLockMetadata'
      readonly file: SourcePolicyFile
      readonly path: string
      readonly inputName: string
      readonly upstreamMember: string
      readonly missingFields: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'GitTransportPinMismatch'
      readonly file: SourcePolicyFile
      readonly path: string
      readonly inputName: string
      readonly upstreamMember: string
      readonly actual: string
      readonly expected: string
    }

/** Result of checking source and lock files for canonical GitHub input shape. */
export interface SourcePolicyCheckResult {
  readonly violations: ReadonlyArray<SourcePolicyViolation>
}

const isMainRef = (ref: string | undefined): boolean => ref === undefined || ref === 'main'

const refSuffix = (ref: string | undefined): string => (isMainRef(ref) === true ? '' : `#${ref}`)

const githubFlakeRefSuffix = (ref: string | undefined): string =>
  isMainRef(ref) === true ? '' : `/${ref}`

const normalizeRepoName = (repo: string): string => repo.replace(/\.git$/, '')

const canonicalMemberSource = ({
  owner,
  repo,
  ref,
}: {
  owner: string
  repo: string
  ref: string | undefined
}) => `${owner}/${normalizeRepoName(repo)}${refSuffix(ref)}`

const canonicalFlakeSource = ({
  owner,
  repo,
  ref,
  params = new Map<string, string>(),
}: {
  owner: string
  repo: string
  ref: string | undefined
  params?: ReadonlyMap<string, string>
}) => {
  const canonicalParams = new Map(params)
  canonicalParams.delete('ref')
  canonicalParams.delete('rev')

  return serializeNixFlakeUrl({
    _tag: 'github',
    owner,
    repo: normalizeRepoName(repo),
    ref: githubFlakeRefSuffix(ref) === '' ? undefined : ref,
    params: canonicalParams,
  })
}

const githubRepoFromUrl = (url: string): { owner: string; repo: string } | undefined => {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/,
    /^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/,
  ]

  for (const pattern of patterns) {
    const match = url.match(pattern)
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { owner: match[1], repo: normalizeRepoName(match[2]) }
    }
  }

  return undefined
}

const normalizedGithubRepo = (repo: {
  owner: string
  repo: string
}): { owner: string; repo: string } => ({
  owner: repo.owner.toLowerCase(),
  repo: normalizeRepoName(repo.repo).toLowerCase(),
})

const memberByGithubRepo = (members: Record<string, LockedMember>) => {
  const result = new Map<string, { memberName: string; owner: string; repo: string }>()

  for (const [memberName, member] of Object.entries(members)) {
    const repo = githubRepoFromUrl(member.url)
    if (repo === undefined) continue
    const normalized = normalizedGithubRepo(repo)
    result.set(`${normalized.owner}/${normalized.repo}`, { memberName, ...repo })
  }

  return result
}

const checkConfigMemberSources = ({
  config,
  configPath,
}: {
  config: MegarepoConfig
  configPath: string
}): ReadonlyArray<SourcePolicyViolation> => {
  const violations: SourcePolicyViolation[] = []

  for (const [memberName, sourceString] of Object.entries(config.members)) {
    const source = parseSourceString(sourceString)
    if (source?.type !== 'url') continue

    const repo = githubRepoFromUrl(source.url)
    if (repo === undefined) continue

    violations.push({
      _tag: 'NonCanonicalGitHubMemberSource',
      file: 'megarepo config',
      path: configPath,
      memberName,
      actual: sourceString,
      expected: canonicalMemberSource({ ...repo, ref: Option.getOrUndefined(source.ref) }),
    })
  }

  return violations
}

const allowsGitTransport = (config: MegarepoConfig, member: string): boolean =>
  config.sourcePolicy?.gitTransportAllowances?.some((allowance) => allowance.member === member) ===
  true

/** Validate the complete URL, rather than the permissive discovery parser's projection. */
const isAllowedGitUrl = (url: string, member: LockedMember): boolean => {
  const repo = githubRepoFromUrl(member.url)
  if (repo === undefined) return false
  const match = url.match(
    /^git\+https:\/\/github\.com\/([^/?#]+)\/([^/?#]+?)(?:\.git)?(?:\?([^#]*))?$/,
  )
  if (
    match === null ||
    match[1]?.toLowerCase() !== repo.owner.toLowerCase() ||
    match[2]?.toLowerCase() !== repo.repo.toLowerCase()
  )
    return false
  const params = new URLSearchParams(match[3])
  const seen = new Set<string>()
  for (const [key, value] of params) {
    if (seen.has(key) || !['rev', 'shallow', 'dir'].includes(key)) return false
    seen.add(key)
    if (key === 'shallow' && value !== '1') return false
    if (value === '') return false
  }
  return params.get('rev') === member.commit
}

const isAllowedGitLock = (
  section: Record<string, unknown> | undefined,
  member: LockedMember,
): boolean => {
  if (section?.['type'] !== 'git' || typeof section['url'] !== 'string') return false
  if (
    Object.keys(section).some(
      (key) => !['type', 'url', 'rev', 'narHash', 'lastModified', 'shallow', 'dir'].includes(key),
    )
  )
    return false
  if (section['shallow'] !== undefined && section['shallow'] !== true) return false
  const params = new URLSearchParams()
  for (const key of ['rev', 'dir'] as const) {
    const value = section[key]
    if (value !== undefined) {
      if (typeof value !== 'string' || value === '') return false
      params.set(key, value)
    }
  }
  if (section['shallow'] === true) params.set('shallow', '1')
  const url = section['url']
  // Lock files use plain HTTPS; the declaration carries the git+ prefix.
  const base = url.startsWith('https://') ? `git+${url}` : url
  const separator = base.includes('?') ? '&' : '?'
  return isAllowedGitUrl(`${base}${separator}${params}`, member)
}

const checkSourceInputs = ({
  content,
  file,
  path,
  members,
  config,
}: {
  content: string
  file: 'flake.nix' | 'devenv.yaml'
  path: string
  members: Record<string, LockedMember>
  config: MegarepoConfig
}): ReadonlyArray<SourcePolicyViolation> => {
  const inputs =
    file === 'flake.nix' ? extractFlakeNixInputs(content) : extractDevenvYamlInputs(content)
  const violations: SourcePolicyViolation[] = []

  for (const input of inputs) {
    const upstreamMember =
      matchUrlToMember({ url: input.url, members }) ??
      (allowsGitTransport(config, input.inputName) && members[input.inputName] !== undefined
        ? input.inputName
        : undefined)
    if (upstreamMember === undefined) continue

    const parsed = parseNixFlakeUrl(input.url)
    if (parsed?._tag === 'github') continue
    if (
      allowsGitTransport(config, upstreamMember) &&
      isAllowedGitUrl(input.url, members[upstreamMember]!)
    )
      continue
    const repo = githubRepoFromUrl(members[upstreamMember]!.url)
    if (repo === undefined) continue

    violations.push({
      _tag: 'NonCanonicalNixInputSource',
      file,
      path,
      inputName: input.inputName,
      upstreamMember,
      actual: input.url,
      expected: canonicalFlakeSource({
        ...repo,
        ref: parsed === undefined ? undefined : getRef(parsed),
        params: parsed?.params,
      }),
    })
  }

  return violations
}

const lockSourceRepo = (
  section: Record<string, unknown> | undefined,
):
  | {
      owner: string
      repo: string
      ref: string | undefined
      type: string | undefined
      params: ReadonlyMap<string, string>
    }
  | undefined => {
  if (section === undefined) return undefined

  const type = typeof section['type'] === 'string' ? section['type'] : undefined
  const params = lockSourceParams(section)

  if (type === 'github') {
    const owner = section['owner']
    const repo = section['repo']
    return typeof owner === 'string' && typeof repo === 'string'
      ? {
          owner,
          repo,
          ref: typeof section['ref'] === 'string' ? section['ref'] : undefined,
          type,
          params,
        }
      : undefined
  }

  if (type === 'git') {
    const url = section['url']
    if (typeof url !== 'string') return undefined
    const repo = githubRepoFromUrl(url)
    if (repo === undefined) return undefined
    return {
      ...repo,
      ref: typeof section['ref'] === 'string' ? section['ref'] : undefined,
      type,
      params,
    }
  }

  return undefined
}

const lockSourceParams = (section: Record<string, unknown>): ReadonlyMap<string, string> => {
  const params = new Map<string, string>()
  const url = section['url']

  if (typeof url === 'string') {
    try {
      const parsed = new URL(url)
      for (const [key, value] of parsed.searchParams.entries()) {
        params.set(key, value)
      }
    } catch {
      // Keep lock parsing permissive: malformed or non-standard URLs are handled elsewhere.
    }
  }

  const dir = section['dir']
  if (typeof dir === 'string') {
    params.set('dir', dir)
  }

  return params
}

const checkLockFileInputs = ({
  content,
  file,
  path,
  members,
  config,
}: {
  content: string
  file: 'flake.lock' | 'devenv.lock'
  path: string
  members: Record<string, LockedMember>
  config: MegarepoConfig
}): ReadonlyArray<SourcePolicyViolation> => {
  let parsed: { root?: string; nodes?: Record<string, Record<string, unknown>> }
  try {
    parsed = JSON.parse(content) as {
      root?: string
      nodes?: Record<string, Record<string, unknown>>
    }
  } catch {
    return []
  }

  const nodes = parsed.nodes
  if (nodes === undefined) return []

  const root = nodes[parsed.root ?? 'root']
  const rootInputs = root?.['inputs'] as Record<string, string> | undefined
  if (rootInputs === undefined) return []

  const membersByRepo = memberByGithubRepo(members)
  const violations: SourcePolicyViolation[] = []

  for (const [inputName, nodeName] of Object.entries(rootInputs)) {
    const node = nodes[nodeName]
    const locked = node?.['locked'] as Record<string, unknown> | undefined
    if (locked === undefined) continue

    const original = node?.['original'] as Record<string, unknown> | undefined
    const lockedRepo = lockSourceRepo(locked)
    const originalRepo = lockSourceRepo(original)
    const upstream = [originalRepo, lockedRepo].flatMap((sourceRepo) => {
      if (sourceRepo === undefined) return []
      const normalized = normalizedGithubRepo(sourceRepo)
      const member = membersByRepo.get(`${normalized.owner}/${normalized.repo}`)
      return member === undefined ? [] : [member]
    })[0]
    if (upstream === undefined) continue

    const member = members[upstream.memberName]!
    const gitAllowed =
      allowsGitTransport(config, upstream.memberName) &&
      locked['type'] === 'git' &&
      isAllowedGitLock({ ...locked, rev: member.commit }, member) &&
      isAllowedGitLock(original, member)

    if ((lockedRepo?.type !== 'github' || originalRepo?.type === 'git') && gitAllowed === false) {
      violations.push({
        _tag: 'NonCanonicalNixInputSource',
        file,
        path,
        inputName,
        upstreamMember: upstream.memberName,
        actual: JSON.stringify({ original, locked }),
        expected: canonicalFlakeSource({
          owner: upstream.owner,
          repo: upstream.repo,
          ref: originalRepo?.ref ?? lockedRepo?.ref,
          params: originalRepo?.params ?? lockedRepo?.params,
        }),
      })
      continue
    }

    const missingFields = ['rev', 'narHash', 'lastModified'].filter((field) =>
      gitAllowed
        ? field === 'lastModified'
          ? typeof locked[field] !== 'number' || !Number.isFinite(locked[field])
          : typeof locked[field] !== 'string' || locked[field] === ''
        : locked[field] === undefined,
    )
    if (missingFields.length > 0) {
      violations.push({
        _tag: 'IncompleteGitHubLockMetadata',
        file,
        path,
        inputName,
        upstreamMember: upstream.memberName,
        missingFields,
      })
    }
    if (gitAllowed && typeof locked['rev'] === 'string' && locked['rev'] !== member.commit) {
      violations.push({
        _tag: 'GitTransportPinMismatch',
        file,
        path,
        inputName,
        upstreamMember: upstream.memberName,
        actual: locked['rev'],
        expected: member.commit,
      })
    }
  }

  return violations
}

const readIfExists = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if ((yield* fs.exists(path)) === false) return undefined
    return yield* fs.readFileString(path)
  })

const checkDirectoryFiles = ({
  dir,
  label,
  members,
  config,
}: {
  dir: AbsoluteDirPath
  label: string
  members: Record<string, LockedMember>
  config: MegarepoConfig
}) =>
  Effect.gen(function* () {
    const violations: SourcePolicyViolation[] = []

    for (const file of ['flake.nix', 'devenv.yaml'] as const) {
      const path = EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile(file))
      const content = yield* readIfExists(path)
      if (content !== undefined) {
        violations.push(
          ...checkSourceInputs({ content, file, path: `${label}/${file}`, members, config }),
        )
      }
    }

    for (const file of ['flake.lock', 'devenv.lock'] as const) {
      const path = EffectPath.ops.join(dir, EffectPath.unsafe.relativeFile(file))
      const content = yield* readIfExists(path)
      if (content !== undefined) {
        violations.push(
          ...checkLockFileInputs({ content, file, path: `${label}/${file}`, members, config }),
        )
      }
    }

    return violations
  })

/** Check a megarepo for canonical GitHub member sources and Nix input locks. */
export const checkSourcePolicy = ({
  megarepoRoot,
  config,
  lockFile,
  includeMembers,
}: {
  megarepoRoot: AbsoluteDirPath
  config: MegarepoConfig
  lockFile: LockFile
  includeMembers: boolean
}): Effect.Effect<SourcePolicyCheckResult, PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const violations: SourcePolicyViolation[] = [
      ...checkConfigMemberSources({
        config,
        configPath: 'megarepo config',
      }),
    ]

    violations.push(
      ...(yield* checkDirectoryFiles({
        dir: megarepoRoot,
        label: '.',
        members: lockFile.members,
        config,
      })),
    )

    if (includeMembers === true) {
      for (const memberName of Object.keys(config.members)) {
        violations.push(
          ...(yield* checkDirectoryFiles({
            dir: getMemberPath({ megarepoRoot, name: memberName }),
            label: `repos/${memberName}`,
            members: lockFile.members,
            config,
          })),
        )
      }
    }

    return { violations }
  })

/** Format a source-policy violation for human-readable CLI output. */
export const formatSourcePolicyViolation = (violation: SourcePolicyViolation): string => {
  switch (violation._tag) {
    case 'NonCanonicalGitHubMemberSource':
      return `${violation.path}: member ${violation.memberName} uses ${violation.actual}; expected ${violation.expected}`
    case 'NonCanonicalNixInputSource':
      return `${violation.path}: input ${violation.inputName} -> ${violation.upstreamMember} uses ${violation.actual}; expected ${violation.expected}`
    case 'IncompleteGitHubLockMetadata':
      return `${violation.path}: input ${violation.inputName} -> ${violation.upstreamMember} is missing GitHub lock metadata: ${violation.missingFields.join(', ')}`
    case 'GitTransportPinMismatch':
      return `${violation.path}: input ${violation.inputName} -> ${violation.upstreamMember} uses git revision ${violation.actual}; expected member pin ${violation.expected}`
  }
}
