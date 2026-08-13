import path from 'node:path'

/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args, overeng/explicit-boolean-compare, unicorn/no-array-sort, unicorn/consistent-function-scoping, no-map-spread -- The lockfile compiler mirrors pnpm's dense wire schema; code-unit comparators, copy-on-write projections, and local graph predicates are deliberate identity mechanics. */
import {
  canonicalJsonString,
  canonicalSha256,
  compareCodeUnits,
  sortedRecord,
} from './canonical.ts'
import {
  PackageContentId,
  PackageContextId,
  TaskClosureId,
  closureCompilerAbi,
  supportedLockfileVersion,
  supportedPnpmVersion,
  type ClosureShard,
  type CompiledTaskClosure,
  type CompiledTaskRoot,
  type DependencyField,
  type ExcludedOptionalContext,
  type ExecutionPlatform,
  type PackageContentRecord,
  type PackageContextRecord,
  type PnpmDependencyReference,
  type PnpmLockfileV9,
  type PnpmPackageSnapshot,
  type PnpmResolvedSnapshot,
  type ProvenanceRecord,
  type TaskClosureRequest,
  type VerifiedNormalizedPayload,
  type WorkspaceTaskRoot,
} from './model.ts'

export type PnpmClosureCompileErrorCode =
  | 'DUPLICATE_ROOT'
  | 'INCOMPATIBLE_REQUIRED_PACKAGE'
  | 'INVALID_LOCKFILE_VERSION'
  | 'INVALID_PNPM_VERSION'
  | 'MISSING_IMPORTER'
  | 'MISSING_PACKAGE_CONTENT_DIGEST'
  | 'MISSING_PACKAGE_RECORD'
  | 'MISSING_ROOT'
  | 'MISSING_SNAPSHOT'
  | 'MISSING_WORKSPACE_LABEL'
  | 'NON_CANONICAL_PATH_OR_LABEL'
  | 'PATCH_METADATA_MISSING'
  | 'UNRESOLVED_WORKSPACE_REFERENCE'

export class PnpmClosureCompileError extends Error {
  readonly code: PnpmClosureCompileErrorCode
  readonly evidence: Readonly<Record<string, string>>

  constructor(args: {
    readonly code: PnpmClosureCompileErrorCode
    readonly message: string
    readonly evidence?: Readonly<Record<string, string>>
  }) {
    super(args.message)
    this.name = 'PnpmClosureCompileError'
    this.code = args.code
    this.evidence = args.evidence ?? {}
  }
}

export interface CompilePnpmTaskClosureOptions {
  readonly pnpmVersion: string
  readonly lockfile: PnpmLockfileV9
  readonly request: TaskClosureRequest
  readonly workspaceLabels: Readonly<Record<string, string>>
  /** Verified normalized final package trees and package-specific policy evidence. */
  readonly normalizedPayloads: Readonly<Record<string, VerifiedNormalizedPayload>>
}

interface ExternalReference {
  readonly kind: 'external'
  readonly depPath: string
}

interface WorkspaceReference {
  readonly kind: 'workspace'
  readonly importerId: string
  readonly pnpmReference: string
  readonly peerContext?: string
  readonly snapshotDepPath?: string
}

type ResolvedReference = ExternalReference | WorkspaceReference

interface Reachability {
  readonly required: boolean
  readonly requiredBy: string
}

interface ExcludedOptionalSelection extends ExcludedOptionalContext {
  readonly requiredBy: string
}

const decodePackageContentId = PackageContentId.decode
const decodePackageContextId = PackageContextId.decode
const decodeTaskClosureId = TaskClosureId.decode

const referenceVersion = (reference: PnpmDependencyReference): string =>
  typeof reference === 'string' ? reference : reference.version

/** Mirrors pnpm 11.8's dependency-path suffix scan without interpreting peer text. */
const suffixIndexes = (depPath: string): { readonly patch: number; readonly peers: number } => {
  if (!depPath.endsWith(')')) return { patch: -1, peers: -1 }
  let open = 1
  for (let index = depPath.length - 2; index >= 0; index--) {
    const character = depPath[index]
    if (character === '(') open--
    else if (character === ')') open++
    else if (open === 0) {
      if (depPath.slice(index + 1).startsWith('(patch_hash=')) {
        return { patch: index + 1, peers: depPath.indexOf('(', index + 2) }
      }
      return { patch: -1, peers: index + 1 }
    }
  }
  return { patch: -1, peers: -1 }
}

const packageBaseKey = (depPath: string): string => {
  const indexes = suffixIndexes(depPath)
  const suffix = indexes.patch === -1 ? indexes.peers : indexes.patch
  return suffix === -1 ? depPath : depPath.slice(0, suffix)
}

const patchHashFromDepPath = (depPath: string): string | undefined => {
  const { patch, peers } = suffixIndexes(depPath)
  if (patch === -1) return undefined
  const end = peers === -1 ? depPath.length : peers
  const suffix = depPath.slice(patch, end)
  return suffix.startsWith('(patch_hash=') && suffix.endsWith(')')
    ? suffix.slice('(patch_hash='.length, -1)
    : undefined
}

/** Mirrors `@pnpm/deps.path` `refToRelative` for pnpm lockfile v9. */
const externalDepPath = (reference: string, alias: string): string | undefined => {
  if (reference.startsWith('link:')) return undefined
  if (reference[0] === '@') return reference
  const at = reference.indexOf('@')
  if (at === -1) return `${alias}@${reference}`
  const colon = reference.indexOf(':')
  const bracket = reference.indexOf('(')
  if ((colon === -1 || at < colon) && (bracket === -1 || at < bracket)) return reference
  return `${alias}@${reference}`
}

const normalizeImporterId = (value: string): string => {
  const normalized = path.posix.normalize(value)
  return normalized === '.' ? '.' : normalized.replace(/^\.\//, '')
}

const assertCanonicalImporterId = (importerId: string): void => {
  if (
    normalizeImporterId(importerId) !== importerId ||
    path.posix.isAbsolute(importerId) ||
    importerId === '..' ||
    importerId.startsWith('../')
  ) {
    throw new PnpmClosureCompileError({
      code: 'NON_CANONICAL_PATH_OR_LABEL',
      message: `Importer ID ${importerId} is not a canonical repository-relative path`,
      evidence: { importerId },
    })
  }
}

const assertCanonicalBuckLabel = (label: string): void => {
  const [pathPart, target, ...rest] = label.split(':')
  const repositoryPath = pathPart?.slice(2) ?? ''
  const pathSegments = repositoryPath === '' ? [] : repositoryPath.split('/')
  if (
    !label.startsWith('//') ||
    rest.length > 0 ||
    target === undefined ||
    target.length === 0 ||
    label.trim() !== label ||
    pathSegments.some((segment) => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    throw new PnpmClosureCompileError({
      code: 'NON_CANONICAL_PATH_OR_LABEL',
      message: `Buck label ${label} is not canonical`,
      evidence: { label },
    })
  }
}

const peerContextFromReference = (reference: string): string | undefined => {
  const { peers } = suffixIndexes(reference)
  return peers === -1 ? undefined : reference.slice(peers)
}

const platformMismatch = (
  pkg: PnpmPackageSnapshot,
  platform: ExecutionPlatform,
): 'cpu' | 'libc' | 'os' | undefined => {
  const matches = (values: readonly string[] | undefined, actual: string | undefined): boolean => {
    if (values === undefined || values.length === 0) return true
    const negatives = values.filter((value) => value.startsWith('!')).map((value) => value.slice(1))
    if (actual !== undefined && negatives.includes(actual)) return false
    const positives = values.filter((value) => !value.startsWith('!'))
    return positives.length === 0 || (actual !== undefined && positives.includes(actual))
  }
  if (!matches(pkg.os, platform.os)) return 'os'
  if (!matches(pkg.cpu, platform.cpu)) return 'cpu'
  if (!matches(pkg.libc, platform.libc)) return 'libc'
  return undefined
}

const workspaceForDirectory = (directory: string, lockfile: PnpmLockfileV9): string | undefined => {
  const normalized = normalizeImporterId(directory)
  return lockfile.importers[normalized] === undefined ? undefined : normalized
}

const resolveReference = (args: {
  readonly alias: string
  readonly importerId: string
  readonly lockfile: PnpmLockfileV9
  readonly reference: string
}): ResolvedReference => {
  if (args.reference.startsWith('link:')) {
    const relative = args.reference.slice('link:'.length)
    const importerId = normalizeImporterId(path.posix.join(args.importerId, relative))
    if (args.lockfile.importers[importerId] === undefined) {
      throw new PnpmClosureCompileError({
        code: 'UNRESOLVED_WORKSPACE_REFERENCE',
        message: `Workspace link ${args.reference} from ${args.importerId} does not resolve to an importer`,
        evidence: { alias: args.alias, importerId: args.importerId, reference: args.reference },
      })
    }
    return { kind: 'workspace', importerId, pnpmReference: args.reference }
  }

  const depPath = externalDepPath(args.reference, args.alias)
  if (depPath === undefined) {
    throw new PnpmClosureCompileError({
      code: 'MISSING_PACKAGE_RECORD',
      message: `Unable to convert ${args.reference} to a pnpm dependency path`,
      evidence: { alias: args.alias, reference: args.reference },
    })
  }
  const baseKey = packageBaseKey(depPath)
  const pkg = args.lockfile.packages[baseKey]
  const directory = pkg?.resolution.type === 'directory' ? pkg.resolution.directory : undefined
  const workspaceImporter =
    directory === undefined ? undefined : workspaceForDirectory(directory, args.lockfile)
  if (workspaceImporter !== undefined) {
    const peerContext = peerContextFromReference(depPath)
    return {
      kind: 'workspace',
      importerId: workspaceImporter,
      pnpmReference: args.reference,
      ...(peerContext === undefined ? {} : { peerContext }),
      snapshotDepPath: depPath,
    }
  }
  return { kind: 'external', depPath }
}

const makeContentRecord = (args: {
  readonly depPath: string
  readonly knownPatchHashes: ReadonlySet<string>
  readonly pkg: PnpmPackageSnapshot
  readonly normalizedPayloads: Readonly<Record<string, VerifiedNormalizedPayload>>
}): PackageContentRecord => {
  const baseKey = packageBaseKey(args.depPath)
  const patchHash = patchHashFromDepPath(args.depPath)
  if (args.pkg.patched === true && patchHash === undefined) {
    throw new PnpmClosureCompileError({
      code: 'PATCH_METADATA_MISSING',
      message: `Patched package ${args.depPath} has no patch hash in its contextual path`,
      evidence: { baseKey, depPath: args.depPath },
    })
  }
  if (patchHash !== undefined && !args.knownPatchHashes.has(patchHash)) {
    throw new PnpmClosureCompileError({
      code: 'PATCH_METADATA_MISSING',
      message: `Patch hash ${patchHash} for ${args.depPath} is absent from patchedDependencies`,
      evidence: { baseKey, depPath: args.depPath, patchHash },
    })
  }
  const normalizedPayload = args.normalizedPayloads[args.depPath]
  if (normalizedPayload === undefined) {
    throw new PnpmClosureCompileError({
      code: 'MISSING_PACKAGE_CONTENT_DIGEST',
      message: `Package ${args.depPath} has no verified normalized payload digest`,
      evidence: { baseKey, depPath: args.depPath },
    })
  }
  const normalizedPayloadDigest = normalizedPayload.digest
  const hash = canonicalSha256({
    schema: 1,
    normalizedPayloadDigest,
  })
  return {
    id: decodePackageContentId(`pc1_${hash}`),
    normalizedPayloadDigest,
  }
}

const dependencyEntries = (
  snapshot: PnpmResolvedSnapshot,
): readonly (readonly [DependencyField, string, string])[] =>
  [
    ...Object.entries(snapshot.dependencies ?? {}).map(
      ([alias, reference]) => ['dependencies', alias, reference] as const,
    ),
    ...Object.entries(snapshot.optionalDependencies ?? {}).map(
      ([alias, reference]) => ['optionalDependencies', alias, reference] as const,
    ),
  ].sort(
    (left, right) =>
      compareCodeUnits(left[0], right[0]) ||
      compareCodeUnits(left[1], right[1]) ||
      compareCodeUnits(left[2], right[2]),
  )

interface PreparedContextRecord {
  readonly depPath: string
  readonly content: PackageContentId
  readonly dependencies: Readonly<Record<string, string>>
  readonly optionalDependencies: Readonly<Record<string, string>>
  readonly peerBindings: Readonly<Record<string, string>>
  readonly workspaceDependencies: PackageContextRecord['workspaceDependencies']
  readonly transitivePeerDependencies: readonly string[]
  readonly constraints: PackageContextRecord['constraints']
}

/** Context IDs name only reusable local records; task graphs resolve their locators. */
const computeContextIds = (
  nodes: ReadonlyMap<string, PreparedContextRecord>,
): ReadonlyMap<string, PackageContextId> => {
  const ids = new Map<string, PackageContextId>()
  for (const [depPath, node] of [...nodes.entries()].sort(([left], [right]) =>
    compareCodeUnits(left, right),
  )) {
    ids.set(depPath, decodePackageContextId(`px1_${canonicalSha256({ schema: 1, ...node })}`))
  }
  return ids
}

const workspaceRoot = (args: {
  readonly alias: string
  readonly field: DependencyField
  readonly reference: WorkspaceReference
  readonly workspaceLabels: Readonly<Record<string, string>>
}): WorkspaceTaskRoot => {
  const buckLabel = args.workspaceLabels[args.reference.importerId]
  if (buckLabel === undefined) {
    throw new PnpmClosureCompileError({
      code: 'MISSING_WORKSPACE_LABEL',
      message: `Workspace importer ${args.reference.importerId} has no Buck label`,
      evidence: { alias: args.alias, importerId: args.reference.importerId },
    })
  }
  assertCanonicalBuckLabel(buckLabel)
  return {
    kind: 'workspace',
    alias: args.alias,
    field: args.field,
    importerId: args.reference.importerId,
    buckLabel,
    pnpmReference: args.reference.pnpmReference,
    ...(args.reference.peerContext === undefined
      ? {}
      : { peerContext: args.reference.peerContext }),
  }
}

export const compilePnpmTaskClosure = (
  options: CompilePnpmTaskClosureOptions,
): CompiledTaskClosure => {
  if (options.pnpmVersion !== supportedPnpmVersion) {
    throw new PnpmClosureCompileError({
      code: 'INVALID_PNPM_VERSION',
      message: `Expected pnpm ${supportedPnpmVersion}, received ${options.pnpmVersion}`,
      evidence: { actual: options.pnpmVersion, expected: supportedPnpmVersion },
    })
  }
  if (options.lockfile.lockfileVersion !== supportedLockfileVersion) {
    throw new PnpmClosureCompileError({
      code: 'INVALID_LOCKFILE_VERSION',
      message: `Expected lockfile ${supportedLockfileVersion}, received ${options.lockfile.lockfileVersion}`,
      evidence: { actual: options.lockfile.lockfileVersion, expected: supportedLockfileVersion },
    })
  }
  assertCanonicalImporterId(options.request.importerId)
  assertCanonicalBuckLabel(options.request.label)
  const seenRoots = new Set<string>()
  for (const root of options.request.roots) {
    const key = `${root.field}\0${root.alias}`
    if (seenRoots.has(key)) {
      throw new PnpmClosureCompileError({
        code: 'DUPLICATE_ROOT',
        message: `Task root ${root.field}.${root.alias} is declared more than once`,
        evidence: { alias: root.alias, field: root.field },
      })
    }
    seenRoots.add(key)
  }
  const importer = options.lockfile.importers[options.request.importerId]
  if (importer === undefined) {
    throw new PnpmClosureCompileError({
      code: 'MISSING_IMPORTER',
      message: `Importer ${options.request.importerId} is absent from the lockfile`,
      evidence: { importerId: options.request.importerId },
    })
  }

  const roots: CompiledTaskRoot[] = []
  const queue: Array<{ readonly depPath: string; readonly reachability: Reachability }> = []
  const selectionRoots = new Set<string>()
  const injectedWorkspaceSnapshots: string[] = []
  for (const root of [...options.request.roots].sort(
    (left, right) =>
      compareCodeUnits(left.alias, right.alias) || compareCodeUnits(left.field, right.field),
  )) {
    const reference = importer[root.field]?.[root.alias]
    if (reference === undefined) {
      throw new PnpmClosureCompileError({
        code: 'MISSING_ROOT',
        message: `${root.alias} is absent from ${options.request.importerId}.${root.field}`,
        evidence: { alias: root.alias, field: root.field, importerId: options.request.importerId },
      })
    }
    const version = referenceVersion(reference)
    const resolved = resolveReference({
      alias: root.alias,
      importerId: options.request.importerId,
      lockfile: options.lockfile,
      reference: version,
    })
    if (resolved.kind === 'workspace') {
      roots.push(
        workspaceRoot({
          alias: root.alias,
          field: root.field,
          reference: resolved,
          workspaceLabels: options.workspaceLabels,
        }),
      )
      if (resolved.snapshotDepPath !== undefined)
        injectedWorkspaceSnapshots.push(resolved.snapshotDepPath)
    } else {
      selectionRoots.add(resolved.depPath)
      queue.push({
        depPath: resolved.depPath,
        reachability: {
          required: root.field !== 'optionalDependencies',
          requiredBy: `importers/${options.request.importerId}/${root.field}/${root.alias}`,
        },
      })
      roots.push({
        kind: 'external',
        alias: root.alias,
        field: root.field,
        context: decodePackageContextId(`px1_${'0'.repeat(64)}`),
      })
    }
  }

  for (const depPath of injectedWorkspaceSnapshots) {
    const snapshot = options.lockfile.snapshots[depPath]
    if (snapshot === undefined) {
      throw new PnpmClosureCompileError({
        code: 'MISSING_SNAPSHOT',
        message: `Injected workspace context ${depPath} has no snapshot`,
        evidence: { depPath },
      })
    }
    for (const [field, alias, reference] of dependencyEntries(snapshot)) {
      const resolved = resolveReference({
        alias,
        importerId: '.',
        lockfile: options.lockfile,
        reference,
      })
      if (resolved.kind === 'external') {
        selectionRoots.add(resolved.depPath)
        queue.push({
          depPath: resolved.depPath,
          reachability: {
            required: field !== 'optionalDependencies',
            requiredBy: `snapshots/${depPath}/${field}/${alias}`,
          },
        })
      }
    }
  }

  const selected = new Map<string, Reachability>()
  const excluded = new Map<string, ExcludedOptionalSelection>()
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const previous = selected.get(current.depPath)
    if (previous?.required === true || previous?.required === current.reachability.required)
      continue
    const baseKey = packageBaseKey(current.depPath)
    const pkg = options.lockfile.packages[baseKey]
    if (pkg === undefined) {
      throw new PnpmClosureCompileError({
        code: 'MISSING_PACKAGE_RECORD',
        message: `Package record ${baseKey} required by ${current.depPath} is absent`,
        evidence: {
          baseKey,
          depPath: current.depPath,
          requiredBy: current.reachability.requiredBy,
        },
      })
    }
    const snapshot = options.lockfile.snapshots[current.depPath]
    if (snapshot === undefined) {
      throw new PnpmClosureCompileError({
        code: 'MISSING_SNAPSHOT',
        message: `Snapshot ${current.depPath} is absent`,
        evidence: { depPath: current.depPath, requiredBy: current.reachability.requiredBy },
      })
    }
    const mismatch = platformMismatch(pkg, options.request.platform)
    if (mismatch !== undefined) {
      if (current.reachability.required) {
        throw new PnpmClosureCompileError({
          code: 'INCOMPATIBLE_REQUIRED_PACKAGE',
          message: `Required package ${current.depPath} is incompatible with the selected platform`,
          evidence: {
            depPath: current.depPath,
            mismatch,
            requiredBy: current.reachability.requiredBy,
          },
        })
      }
      excluded.set(current.depPath, {
        depPath: current.depPath,
        reason: mismatch,
        requiredBy: current.reachability.requiredBy,
      })
      continue
    }
    selected.set(current.depPath, current.reachability)
    excluded.delete(current.depPath)
    for (const [field, alias, reference] of dependencyEntries(snapshot)) {
      const resolved = resolveReference({
        alias,
        importerId: '.',
        lockfile: options.lockfile,
        reference,
      })
      if (resolved.kind === 'external') {
        queue.push({
          depPath: resolved.depPath,
          reachability: {
            required: current.reachability.required && field !== 'optionalDependencies',
            requiredBy: `snapshots/${current.depPath}/${field}/${alias}`,
          },
        })
      }
    }
  }

  // An optional package is usable only when all of its ordinary dependencies
  // are usable. Propagate an incompatible required child back through the
  // optional branch instead of silently constructing a parent context with the
  // required edge omitted. Repeat to cover arbitrarily deep optional branches.
  let prunedOptionalParent = true
  while (prunedOptionalParent) {
    prunedOptionalParent = false
    for (const [depPath, reachability] of selected) {
      if (reachability.required) continue
      const snapshot = options.lockfile.snapshots[depPath]
      if (snapshot === undefined) continue
      for (const [field, alias, reference] of dependencyEntries(snapshot)) {
        if (field === 'optionalDependencies') continue
        const resolved = resolveReference({
          alias,
          importerId: '.',
          lockfile: options.lockfile,
          reference,
        })
        if (resolved.kind !== 'external' || selected.has(resolved.depPath)) continue
        const childExclusion = excluded.get(resolved.depPath)
        if (childExclusion === undefined) continue
        selected.delete(depPath)
        excluded.set(depPath, {
          depPath,
          reason: childExclusion.reason,
          requiredBy: `snapshots/${depPath}/${field}/${alias}`,
        })
        prunedOptionalParent = true
        break
      }
    }
  }

  // Selection initially walks every candidate branch so an optional parent's
  // required-child failure can be propagated precisely. Once those parents
  // are pruned, retain only contexts reachable from surviving task/workspace
  // roots; compatible siblings beneath a rejected branch are not part of the
  // exact closure.
  const reachable = new Set<string>()
  const reachabilityQueue = [...selectionRoots].filter((depPath) => selected.has(depPath))
  while (reachabilityQueue.length > 0) {
    const depPath = reachabilityQueue.shift()
    if (depPath === undefined || reachable.has(depPath)) continue
    reachable.add(depPath)
    const snapshot = options.lockfile.snapshots[depPath]
    if (snapshot === undefined) continue
    for (const [, alias, reference] of dependencyEntries(snapshot)) {
      const resolved = resolveReference({
        alias,
        importerId: '.',
        lockfile: options.lockfile,
        reference,
      })
      if (
        resolved.kind === 'external' &&
        selected.has(resolved.depPath) &&
        !reachable.has(resolved.depPath)
      )
        reachabilityQueue.push(resolved.depPath)
    }
  }
  for (const depPath of selected.keys()) {
    if (!reachable.has(depPath)) selected.delete(depPath)
  }

  const knownPatchHashes = new Set(Object.values(options.lockfile.patchedDependencies ?? {}))
  const contentByDepPath = new Map<string, PackageContentRecord>()
  for (const depPath of [...selected.keys()].sort(compareCodeUnits)) {
    const pkg = options.lockfile.packages[packageBaseKey(depPath)]
    const snapshot = options.lockfile.snapshots[depPath]
    if (pkg === undefined || snapshot === undefined) continue
    const content = makeContentRecord({
      depPath,
      knownPatchHashes,
      pkg,
      normalizedPayloads: options.normalizedPayloads,
    })
    contentByDepPath.set(depPath, content)
  }

  const workspaceDependency = (args: {
    readonly alias: string
    readonly reference: WorkspaceReference
  }) => {
    const buckLabel = options.workspaceLabels[args.reference.importerId]
    if (buckLabel === undefined) {
      throw new PnpmClosureCompileError({
        code: 'MISSING_WORKSPACE_LABEL',
        message: `Workspace importer ${args.reference.importerId} has no Buck label`,
        evidence: { alias: args.alias, importerId: args.reference.importerId },
      })
    }
    assertCanonicalBuckLabel(buckLabel)
    return {
      importerId: args.reference.importerId,
      buckLabel,
      pnpmReference: args.reference.pnpmReference,
    }
  }

  const preparedContexts = new Map<string, PreparedContextRecord>()
  for (const depPath of [...selected.keys()].sort(compareCodeUnits)) {
    const pkg = options.lockfile.packages[packageBaseKey(depPath)]
    const snapshot = options.lockfile.snapshots[depPath]
    const content = contentByDepPath.get(depPath)
    if (pkg === undefined || snapshot === undefined || content === undefined) continue
    const dependencyTargets: Array<readonly [string, string]> = []
    const optionalDependencyTargets: Array<readonly [string, string]> = []
    const workspaceDependencies: Array<
      readonly [
        string,
        { readonly importerId: string; readonly buckLabel: string; readonly pnpmReference: string },
      ]
    > = []
    for (const [field, alias, reference] of dependencyEntries(snapshot)) {
      const resolved = resolveReference({
        alias,
        importerId: '.',
        lockfile: options.lockfile,
        reference,
      })
      if (resolved.kind === 'workspace') {
        workspaceDependencies.push([alias, workspaceDependency({ alias, reference: resolved })])
      } else if (selected.has(resolved.depPath)) {
        if (field === 'optionalDependencies')
          optionalDependencyTargets.push([alias, resolved.depPath])
        else dependencyTargets.push([alias, resolved.depPath])
      }
    }
    const dependencies = sortedRecord(dependencyTargets)
    const optionalDependencies = sortedRecord(optionalDependencyTargets)
    const peerBindings = sortedRecord(
      Object.keys(pkg.peerDependencies ?? {}).flatMap((alias) => {
        const target = dependencies[alias] ?? optionalDependencies[alias]
        return target === undefined ? [] : [[alias, target] as const]
      }),
    )
    preparedContexts.set(depPath, {
      depPath,
      content: content.id,
      dependencies,
      optionalDependencies,
      peerBindings,
      workspaceDependencies: sortedRecord(workspaceDependencies),
      transitivePeerDependencies: [...(snapshot.transitivePeerDependencies ?? [])].sort(
        compareCodeUnits,
      ),
      constraints: {
        os: [...(pkg.os ?? [])].sort(compareCodeUnits),
        cpu: [...(pkg.cpu ?? [])].sort(compareCodeUnits),
        libc: [...(pkg.libc ?? [])].sort(compareCodeUnits),
        engines: sortedRecord(Object.entries(pkg.engines ?? {})),
      },
    })
  }
  const contextIdByDepPath = computeContextIds(preparedContexts)

  const contextRecords = new Map<string, PackageContextRecord>()
  const contentRecords = new Map<string, PackageContentRecord>()
  const provenance: ProvenanceRecord[] = []
  for (const depPath of [...selected.keys()].sort(compareCodeUnits)) {
    const content = contentByDepPath.get(depPath)
    const prepared = preparedContexts.get(depPath)
    const contextId = contextIdByDepPath.get(depPath)
    if (content === undefined || prepared === undefined || contextId === undefined) continue
    contentRecords.set(content.id, content)
    const record: PackageContextRecord = {
      id: contextId,
      depPath: prepared.depPath,
      content: prepared.content,
      dependencies: prepared.dependencies,
      optionalDependencies: prepared.optionalDependencies,
      peerBindings: prepared.peerBindings,
      workspaceDependencies: prepared.workspaceDependencies,
      transitivePeerDependencies: prepared.transitivePeerDependencies,
      constraints: prepared.constraints,
    }
    contextRecords.set(contextId, record)
    provenance.push({
      subject: content.id,
      sources: [`pnpm-lock.yaml#packages/${packageBaseKey(depPath)}`],
      notes: [
        `context ${depPath}`,
        `normalizer ${options.normalizedPayloads[depPath]!.materializer.abi}`,
        `build-policy ${options.normalizedPayloads[depPath]!.materializer.buildPolicyDigest}`,
      ],
    })
    provenance.push({
      subject: contextId,
      sources: [`pnpm-lock.yaml#snapshots/${depPath}`],
      notes: [`platform ${options.request.platform.os}/${options.request.platform.cpu}`],
    })
  }

  const resolvedRoots = roots.map((root) => {
    if (root.kind !== 'external') return root
    const requestRoot = options.request.roots.find(
      (candidate) => candidate.alias === root.alias && candidate.field === root.field,
    )
    const reference = requestRoot === undefined ? undefined : importer[root.field]?.[root.alias]
    const version = reference === undefined ? undefined : referenceVersion(reference)
    const depPath = version === undefined ? undefined : externalDepPath(version, root.alias)
    const context = depPath === undefined ? undefined : contextIdByDepPath.get(depPath)
    if (context === undefined) {
      const exclusion = depPath === undefined ? undefined : excluded.get(depPath)
      if (
        root.field === 'optionalDependencies' &&
        depPath !== undefined &&
        exclusion !== undefined
      ) {
        return {
          kind: 'excluded-optional' as const,
          alias: root.alias,
          field: root.field,
          depPath,
          reason: exclusion.reason,
        }
      }
      throw new PnpmClosureCompileError({
        code: 'MISSING_SNAPSHOT',
        message: `Root ${root.alias} did not produce a selected package context`,
        evidence: { alias: root.alias, field: root.field },
      })
    }
    return { ...root, context }
  })
  const contextIds = [...contextRecords.keys()].sort(compareCodeUnits).map(decodePackageContextId)
  const contentIds = [...contentRecords.keys()].sort(compareCodeUnits).map(decodePackageContentId)
  const resolvedIds = (
    entries: Readonly<Record<string, string>>,
  ): Readonly<Record<string, PackageContextId>> =>
    sortedRecord(
      Object.entries(entries).map(([alias, target]) => [alias, contextIdByDepPath.get(target)!]),
    )
  const graph = sortedRecord(
    [...preparedContexts.entries()].map(
      ([depPath, prepared]) =>
        [
          contextIdByDepPath.get(depPath)!,
          {
            dependencies: resolvedIds(prepared.dependencies),
            optionalDependencies: resolvedIds(prepared.optionalDependencies),
            peerBindings: resolvedIds(prepared.peerBindings),
          },
        ] as const,
    ),
  )
  const excludedOptionalContexts = [...excluded.values()].sort(
    (left, right) =>
      compareCodeUnits(left.depPath, right.depPath) ||
      compareCodeUnits(left.requiredBy, right.requiredBy),
  )
  const semanticExcludedOptionalContexts: readonly ExcludedOptionalContext[] =
    excludedOptionalContexts.map(({ depPath, reason }) => ({
      depPath,
      reason,
    }))
  const semanticRoots = resolvedRoots.map((root) => {
    if (root.kind === 'external') {
      return { kind: root.kind, alias: root.alias, field: root.field, context: root.context }
    }
    if (root.kind === 'workspace') {
      return {
        kind: root.kind,
        alias: root.alias,
        field: root.field,
        importerId: root.importerId,
        buckLabel: root.buckLabel,
        pnpmReference: root.pnpmReference,
        peerContext: root.peerContext,
      }
    }
    return {
      kind: root.kind,
      alias: root.alias,
      field: root.field,
      depPath: root.depPath,
      reason: root.reason,
    }
  })
  const taskHash = canonicalSha256({
    schema: 1,
    compilerAbi: closureCompilerAbi,
    label: options.request.label,
    importerId: options.request.importerId,
    mode: options.request.mode,
    platformRole: options.request.platformRole,
    platform: options.request.platform,
    roots: semanticRoots,
    contexts: contextIds,
    contents: contentIds,
    graph,
    excludedOptionalContexts: semanticExcludedOptionalContexts,
  })
  const taskId = decodeTaskClosureId(`tc1_${taskHash}`)
  provenance.push({
    subject: taskId,
    sources: options.request.roots
      .map(
        (root) =>
          `pnpm-lock.yaml#importers/${options.request.importerId}/${root.field}/${root.alias}`,
      )
      .sort(compareCodeUnits),
    notes: [
      `pnpm ${supportedPnpmVersion}`,
      `lockfile ${supportedLockfileVersion}`,
      ...options.request.roots
        .map(({ alias, field, reason }) => `declared ${field}.${alias}: ${reason}`)
        .sort(compareCodeUnits),
      ...excludedOptionalContexts.map(
        ({ depPath, reason, requiredBy }) =>
          `excluded ${depPath} (${reason}) required-by ${requiredBy}`,
      ),
    ],
  })

  return {
    task: {
      id: taskId,
      label: options.request.label,
      importerId: options.request.importerId,
      mode: options.request.mode,
      platformRole: options.request.platformRole,
      platform: options.request.platform,
      roots: resolvedRoots,
      contexts: contextIds,
      contents: contentIds,
      graph,
      excludedOptionalContexts: semanticExcludedOptionalContexts,
    },
    contents: sortedRecord(contentRecords.entries()),
    contexts: sortedRecord(contextRecords.entries()),
    provenance: provenance.sort((left, right) => compareCodeUnits(left.subject, right.subject)),
  }
}

export interface ProvisionalPackageInput {
  readonly depPath: string
  readonly baseKey: string
  readonly packageName?: string
  readonly packageVersion?: string
  readonly patchHash?: string
  readonly sourceResolution: PnpmPackageSnapshot['resolution']
}

export interface PnpmTaskClosureInputPlan {
  readonly packages: readonly ProvisionalPackageInput[]
  readonly excludedOptionalContexts: readonly ExcludedOptionalContext[]
}

/**
 * Discovers materialization inputs without claiming content authority. The
 * returned plan contains no PackageContentId, PackageContextId, or TaskClosureId.
 */
export const discoverPnpmTaskClosureInputs = (
  options: Omit<CompilePnpmTaskClosureOptions, 'normalizedPayloads'>,
): PnpmTaskClosureInputPlan => {
  const provisionalPayloads = sortedRecord(
    Object.keys(options.lockfile.snapshots).map(
      (depPath) =>
        [
          depPath,
          {
            digest: `unverified-plan-only:${depPath}`,
            materializer: {
              abi: 'unverified-plan-only',
              buildPolicyDigest: 'unverified-plan-only',
            },
          },
        ] as const,
    ),
  )
  const provisional = compilePnpmTaskClosure({
    ...options,
    normalizedPayloads: provisionalPayloads,
  })
  return {
    packages: Object.values(provisional.contexts)
      .map((context) => {
        const baseKey = packageBaseKey(context.depPath)
        const pkg = options.lockfile.packages[baseKey]!
        const versionSeparator = baseKey.lastIndexOf('@')
        const packageName =
          pkg.name ?? (versionSeparator > 0 ? baseKey.slice(0, versionSeparator) : undefined)
        const packageVersion =
          pkg.version ?? (versionSeparator > 0 ? baseKey.slice(versionSeparator + 1) : undefined)
        const patchHash = patchHashFromDepPath(context.depPath)
        return {
          depPath: context.depPath,
          baseKey,
          ...(packageName === undefined ? {} : { packageName }),
          ...(packageVersion === undefined ? {} : { packageVersion }),
          ...(patchHash === undefined ? {} : { patchHash }),
          sourceResolution: pkg.resolution,
        }
      })
      .sort((left, right) => compareCodeUnits(left.depPath, right.depPath)),
    excludedOptionalContexts: provisional.task.excludedOptionalContexts,
  }
}

const recordsByShard = <TRecord extends { readonly id: string }>(
  records: readonly TRecord[],
): ReadonlyMap<string, readonly TRecord[]> => {
  const mutable = new Map<string, TRecord[]>()
  for (const record of [...records].sort((left, right) => compareCodeUnits(left.id, right.id))) {
    const shard = record.id.slice(4, 6)
    mutable.set(shard, [...(mutable.get(shard) ?? []), record])
  }
  return new Map([...mutable.entries()].sort(([left], [right]) => compareCodeUnits(left, right)))
}

/** Renders byte-stable content/context/task/provenance shards suitable for Genie output. */
export const renderPnpmClosureShards = (closure: CompiledTaskClosure): readonly ClosureShard[] => {
  const shards: ClosureShard[] = []
  for (const [shard, records] of recordsByShard(Object.values(closure.contents))) {
    shards.push({
      path: `package-content/${shard}.json`,
      bytes: `${canonicalJsonString(records)}\n`,
    })
  }
  for (const [shard, records] of recordsByShard(Object.values(closure.contexts))) {
    shards.push({
      path: `package-context/${shard}.json`,
      bytes: `${canonicalJsonString(records)}\n`,
    })
  }
  shards.push({
    path: `task-closure/${closure.task.id}.json`,
    bytes: `${canonicalJsonString(closure.task)}\n`,
  })
  shards.push({
    path: `provenance/${closure.task.id}.json`,
    bytes: `${canonicalJsonString(closure.provenance)}\n`,
  })
  return shards.sort((left, right) => compareCodeUnits(left.path, right.path))
}
