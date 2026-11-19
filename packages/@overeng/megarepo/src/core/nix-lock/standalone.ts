import { dirname, isAbsolute, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { Effect, Exit, Option, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { EffectPath } from '@overeng/effect-path'

import { authorizeAuthorWorkspaceWrite } from '../../store/store-path.ts'
import {
  buildSourceStringWithRef,
  encodeMegarepoConfigContent,
  getSourceRef,
  getSourceUrl,
  MegarepoConfig,
  parseSourceString,
  readMegarepoConfig,
} from '../config.ts'
import { decodeLockFileContent, LockFile, upsertLockedMember } from '../lock.ts'
import { runCommand } from '../git.ts'
import { isCommitSha } from '../ref.ts'
import {
  extractDevenvYamlInputs,
  extractFlakeNixInputs,
  extractLockFileInputs,
  resolveLockInputNode,
} from './input-discovery.ts'
import { getRef, getRev, parseNixFlakeUrl } from './flake-url.ts'
import { urlsMatch } from './matcher.ts'
import { fetchNixFlakeMetadata } from './mod.ts'
import { rewriteDevenvYamlUrls, rewriteFlakeNixUrls, type SourceUrlUpdate } from './source-rewriter.ts'
import { parseLockedInput } from './schema.ts'

/** Repository identity selects duplicate nodes independently of their lock-local IDs. */
const inputRepositoryUrl = (section: unknown): string | undefined => {
  if (Schema.is(Schema.Record(Schema.String, Schema.Unknown))(section) === false) return undefined
  const parsed = parseLockedInput(section)
  if (parsed?.type === 'github' && parsed.owner !== undefined && parsed.repo !== undefined) {
    return `https://github.com/${parsed.owner}/${parsed.repo}`
  }
  return parsed?.type === 'git' ? parsed.url : undefined
}

const InputMetadata = Schema.Record(Schema.String, Schema.Unknown)

/** Nix hashes the repository source, not the selected flake directory. */
const withoutDir = (metadata: unknown): unknown =>
  Schema.is(InputMetadata)(metadata) === true
    ? Object.fromEntries(Object.entries(metadata).filter(([key]) => key !== 'dir'))
    : metadata

/** Keep arbitrary node metadata, including fields unknown to mr, intact. */
const LockJson = Schema.fromJsonString(
  Schema.StructWithRest(
    Schema.Struct({
      nodes: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
      root: Schema.String,
      version: Schema.Finite,
    }),
    [Schema.Record(Schema.String, Schema.Unknown)],
  ),
  { space: 2 },
)

/** A cohort cannot be repaired safely without a matching original input specification. */
export class StandaloneLockSyncError extends Schema.TaggedError<StandaloneLockSyncError>()(
  'StandaloneLockSyncError',
  { path: Schema.String, input: Schema.String, message: Schema.String },
) {}

/** Check and write use exactly the same discovery, original validation and locked comparison. */
export const syncStandaloneLocks = Effect.fn('nix-lock/syncStandaloneLocks')(function* ({
  root: rootPath,
  input,
  rootLock = 'devenv.lock',
  locks,
  write = false,
  rev,
  ref,
  member,
}: {
  root: string
  input: string
  rootLock?: 'devenv.lock' | 'flake.lock'
  locks?: ReadonlyArray<string>
  write?: boolean
  rev?: string
  ref?: string
  member?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const plans: Array<{ path: string; content: string }> = []
  const checked: string[] = []
  const declarationPaths = new Set<string>()
  const root = rootPath.replace(/\/$/, '')
  if (
    ref !== undefined &&
    (rev === undefined ||
      ref === '@' ||
      isCommitSha(ref) ||
      ref.startsWith('-') ||
      ref.startsWith('refs/') ||
      /[\x00-\x20\x7f~^:?*\[\\]/.test(ref) ||
      ref.includes('..') ||
      ref.includes('@{') ||
      ref.split('/').some((part) => part === '' || part.startsWith('.') || part.endsWith('.lock')) ||
      ref.endsWith('.'))
  ) {
    return yield* new StandaloneLockSyncError({
      path: root,
      input,
      message: '--ref requires --rev and a short published GitHub branch name; no locks written',
    })
  }
  const sourcePath = `${root}/${rootLock}`
  const sourceContent = yield* fs.readFileString(sourcePath)
  const source = yield* Schema.decodeEffect(LockJson)(sourceContent)
  // Reuse the input discovery used by member lock synchronization rather than matching node IDs.
  const discovered = extractLockFileInputs(sourceContent).find((entry) => entry.inputName === input)
  const sourceId = resolveLockInputNode({ ...source, inputName: input })
  const sourceNode = sourceId === undefined ? undefined : source.nodes[sourceId]
  const sourceRepository = inputRepositoryUrl(discovered?.locked)
  if (
    sourceId === undefined ||
    discovered === undefined ||
    sourceNode?.['original'] === undefined ||
    sourceRepository === undefined
  ) {
    return yield* new StandaloneLockSyncError({
      path: sourcePath,
      input,
      message: `Root lock must resolve a GitHub or git input '${input}' with original metadata`,
    })
  }
  const sourceOriginal = withoutDir(sourceNode['original'])
  let sourceLocked = yield* Schema.decodeUnknownEffect(InputMetadata)(withoutDir(discovered.locked))
  const desiredOriginal =
    ref === undefined
      ? sourceOriginal
      : { ...(yield* Schema.decodeUnknownEffect(InputMetadata)(sourceOriginal)), ref }
  const validateDeclarations = Effect.fn(function* (directory: string) {
    if (ref === undefined && member === undefined) return
    for (const [name, extract, rewrite] of [
      ['flake.nix', extractFlakeNixInputs, rewriteFlakeNixUrls],
      ['devenv.yaml', extractDevenvYamlInputs, rewriteDevenvYamlUrls],
    ] as const) {
      const path = `${directory}/${name}`
      if ((yield* fs.exists(path)) === false) continue
      if (declarationPaths.has(path)) continue
      declarationPaths.add(path)
      const content = yield* fs.readFileString(path)
      const updates = new Map<string, SourceUrlUpdate>()
      for (const declaration of extract(content)) {
        const parsed = parseNixFlakeUrl(declaration.url)
        if (
          declaration.inputName !== input &&
          (parsed === undefined ||
            urlsMatch({
              url1: `https://github.com/${parsed.owner}/${parsed.repo}`,
              url2: sourceRepository,
            }) === false)
        ) continue
        const expected = ref ?? (Schema.is(InputMetadata)(sourceOriginal) ? sourceOriginal['ref'] : undefined)
        if (
          typeof expected !== 'string' || parsed === undefined ||
          (getRef(parsed) !== expected &&
            getRef(parsed) !== (Schema.is(InputMetadata)(sourceOriginal) ? sourceOriginal['ref'] : undefined)) ||
          getRev(parsed) !== undefined ||
          urlsMatch({
            url1: `https://github.com/${parsed.owner}/${parsed.repo}`,
            url2: sourceRepository,
          }) === false
        ) {
          return yield* new StandaloneLockSyncError({
            path,
            input,
            message: `Declaration '${declaration.inputName}' must track branch '${expected}'; no locks written`,
          })
        }
        updates.set(declaration.inputName, { memberName: member ?? input, newRef: expected })
      }
      if (updates.size > 0) {
        checked.push(path.slice(root.length + 1))
        const result = rewrite({ content, updates })
        if (result.content !== content) plans.push({ path, content: result.content })
      }
    }
  })
  yield* validateDeclarations(root)
  if (rev !== undefined) {
    const tracking = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        type: Schema.Literal('github'),
        owner: Schema.NonEmptyString,
        repo: Schema.NonEmptyString,
        ref: Schema.NonEmptyString,
        rev: Schema.optional(Schema.String),
      }),
    )(desiredOriginal).pipe(
      Effect.mapError(
        () =>
          new StandaloneLockSyncError({
            path: sourcePath,
            input,
            message:
              '--rev requires a GitHub input with an original tracking ref; no locks written',
          }),
      ),
    )
    if (/^[0-9a-f]{40}$/.test(rev) === false || tracking.rev !== undefined) {
      return yield* new StandaloneLockSyncError({
        path: sourcePath,
        input,
        message:
          '--rev requires a full lowercase 40-character commit SHA and an unpinned original ref; no locks written',
      })
    }
    // Fetch the complete tracking-ref history in isolation: a commit existing
    // elsewhere in the repository is not enough to prove it is reachable.
    const mergeBase = yield* Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'mr-lock-sync-ref-' })
        const spawner = yield* ChildProcessSpawner
        // Ask Git for its repository-local environment contract rather than
        // maintaining a partial list that misses object/index/config overrides.
        const localVariables = yield* spawner.string(
          ChildProcess.make('git', [`--git-dir=${directory}`, 'rev-parse', '--local-env-vars'], {
            // Discovery needs no Git-specific configuration or credentials. Its
            // own process must not inherit repository redirection either.
            env: Object.fromEntries(
              Object.entries(process.env).filter(([name]) => name.startsWith('GIT_') === false),
            ),
            extendEnv: false,
          }),
        )
        const excluded = new Set([
          ...localVariables.trim().split(/\s+/),
          'GIT_NAMESPACE',
          'GIT_CEILING_DIRECTORIES',
          'GIT_DISCOVERY_ACROSS_FILESYSTEM',
        ])
        if (excluded.has('GIT_DIR') === false || excluded.has('GIT_INDEX_FILE') === false) {
          return yield* new StandaloneLockSyncError({
            path: sourcePath,
            input,
            message:
              'Could not discover Git repository-local environment variables; no locks written',
          })
        }
        const options = {
          cwd: directory,
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => excluded.has(name) === false),
          ),
          extendEnv: false,
        }
        yield* spawner.string(
          ChildProcess.make(
            'git',
            [`--git-dir=${directory}`, 'init', '--bare', directory],
            options,
          ),
        )
        yield* spawner.string(
          ChildProcess.make(
            'git',
            [
              `--git-dir=${directory}`,
              'fetch',
              '--no-tags',
              '--',
              `https://github.com/${tracking.owner}/${tracking.repo}.git`,
              ref === undefined ? tracking.ref : `refs/heads/${tracking.ref}`,
            ],
            options,
          ),
        )
        return yield* spawner.string(
          ChildProcess.make(
            'git',
            [`--git-dir=${directory}`, 'merge-base', rev, 'FETCH_HEAD'],
            options,
          ),
        )
      }),
    ).pipe(
      Effect.mapError(
        () =>
          new StandaloneLockSyncError({
            path: sourcePath,
            input,
            message: `Could not verify ${rev} is reachable from '${tracking.ref}' using git; no locks written`,
          }),
      ),
    )
    if (mergeBase.trim() !== rev) {
      return yield* new StandaloneLockSyncError({
        path: sourcePath,
        input,
        message: `Commit ${rev} is not reachable from '${tracking.ref}'; no locks written`,
      })
    }
    const metadata = yield* fetchNixFlakeMetadata({
      owner: tracking.owner,
      repo: tracking.repo,
      rev,
    })
    sourceLocked = {
      ...sourceLocked,
      type: 'github',
      owner: tracking.owner,
      repo: tracking.repo,
      rev,
      ...metadata,
    }
  }

  // Explicit paths are an exact cohort, not Git pathspecs or glob expressions.
  const explicit = locks !== undefined && locks.length > 0
  const selected: string[] = []
  for (const path of locks ?? []) {
    const relative = normalize(path)
    if (
      isAbsolute(path) === true ||
      relative === '..' ||
      relative.startsWith('../') === true ||
      relative === '.' ||
      (relative.endsWith('/flake.lock') === false && relative !== 'flake.lock')
    ) {
      return yield* new StandaloneLockSyncError({
        path,
        input,
        message: `Invalid standalone lock path '${path}'; expected a repository-relative flake.lock; no locks written`,
      })
    }
    selected.push(relative)
  }
  const files =
    explicit === true
      ? selected
      : (yield* runCommand({
          args: [
            'ls-files',
            '-z',
            '--cached',
            '--others',
            '--exclude-standard',
            '--',
            'flake.lock',
            '**/flake.lock',
          ],
          cwd: root,
        }))
          .split('\0')
          .filter((path) => path !== '')
  if (member !== undefined) {
    const configFile = yield* readMegarepoConfig(EffectPath.unsafe.absoluteDir(`${root}/`))
    const memberSource = configFile.config.members[member]
    const parsed = memberSource === undefined ? undefined : parseSourceString(memberSource)
    const url = parsed === undefined ? undefined : getSourceUrl(parsed)
    const targetRef = ref ?? (Schema.is(InputMetadata)(sourceOriginal) ? sourceOriginal['ref'] : undefined)
    const targetRev = sourceLocked['rev']
    const configuredRef = parsed === undefined ? undefined : Option.getOrUndefined(getSourceRef(parsed))
    const previousRef = Schema.is(InputMetadata)(sourceOriginal) ? sourceOriginal['ref'] : undefined
    if (
      memberSource === undefined || parsed === undefined || url === undefined ||
      urlsMatch({ url1: url, url2: sourceRepository }) === false ||
      typeof targetRef !== 'string' || typeof targetRev !== 'string' ||
      (configuredRef !== targetRef && (ref === undefined || configuredRef !== previousRef))
    ) {
      return yield* new StandaloneLockSyncError({
        path: configFile.path,
        input,
        message: `Member '${member}' must declare the same repository and tracking branch as '${input}'; no locks written`,
      })
    }
    checked.push(configFile.path.slice(root.length + 1), 'megarepo.lock')
    const members = { ...configFile.config.members }
    const path = `${root}/megarepo.lock`
    const lock = yield* decodeLockFileContent(yield* fs.readFileString(path))
    let next = lock
    for (const [name, source] of Object.entries(members)) {
      const parsedSource = parseSourceString(source)
      const sourceUrl = parsedSource === undefined ? undefined : getSourceUrl(parsedSource)
      if (sourceUrl === undefined || urlsMatch({ url1: sourceUrl, url2: url }) === false) continue
      const declaredRef = parsedSource === undefined ? undefined : Option.getOrUndefined(getSourceRef(parsedSource))
      const pinnedRevision = declaredRef !== undefined && isCommitSha(declaredRef)
      const nextRef = name !== member && pinnedRevision ? targetRev : targetRef
      const oldRef = Schema.is(InputMetadata)(sourceOriginal) ? sourceOriginal['ref'] : undefined
      if (name !== member && pinnedRevision === false && declaredRef !== targetRef && declaredRef !== oldRef) {
        return yield* new StandaloneLockSyncError({
          path: configFile.path, input,
          message: `Same-repository member '${name}' declares a different tracking branch; no locks written`,
        })
      }
      members[name] = buildSourceStringWithRef({ sourceString: source, newRef: nextRef })
      next = upsertLockedMember({
        lockFile: next,
        memberName: name,
        update: {
          url: sourceUrl, ref: nextRef, commit: targetRev,
          pinned: lock.members[name]?.pinned ?? pinnedRevision,
        },
      })
    }
    if (isDeepStrictEqual(members, configFile.config.members) === false) {
      plans.push({
        path: configFile.path,
        content: yield* encodeMegarepoConfigContent({
          format: configFile.format,
          config: new MegarepoConfig({
            ...configFile.config,
            members,
          }),
        }),
      })
    }
    if (next !== lock) {
      plans.push({ path, content: `${yield* Schema.encodeEffect(Schema.fromJsonString(LockFile, { space: 2 }))(next)}\n` })
    }
    for (const path of ['devenv.lock', 'flake.lock']) {
      if (path !== rootLock && (yield* fs.exists(`${root}/${path}`)) === true) files.push(path)
    }
  }
  if (rev !== undefined && member === undefined && ref === undefined) {
    const original = sourceNode['original']
    const dir = Schema.is(InputMetadata)(original) === true ? original['dir'] : undefined
    const locked = dir === undefined ? sourceLocked : { ...sourceLocked, dir }
    checked.push(rootLock)
    if (isDeepStrictEqual(sourceNode['locked'], locked) === false) {
      const updated = {
        ...source,
        nodes: { ...source.nodes, [sourceId]: { ...sourceNode, locked } },
      }
      plans.push({
        path: sourcePath,
        content: `${yield* Schema.encodeEffect(LockJson)(updated)}\n`,
      })
    }
  }
  // A set avoids duplicate tracked/untracked results; git excludes ignored caches and member mounts.
  for (const relative of [...new Set([
    ...files,
    ...(member !== undefined || ref !== undefined ? [rootLock] : []),
  ])].toSorted()) {
    if (relative === rootLock && member === undefined && ref === undefined) continue
    const path = `${root}/${relative}`
    // Tracked files removed from the worktree are not standalone locks in this consumer.
    if ((yield* fs.exists(path)) === false) {
      if (explicit === true) {
        return yield* new StandaloneLockSyncError({
          path,
          input,
          message: `Selected lock '${relative}' does not exist; no locks written`,
        })
      }
      continue
    }
    const content = yield* fs.readFileString(path)
    yield* validateDeclarations(dirname(path))
    const lock = yield* Schema.decodeEffect(LockJson)(content)
    const declaredRoot = lock.nodes[lock.root]
    if (declaredRoot === undefined) {
      return yield* new StandaloneLockSyncError({
        path,
        input,
        message: `Declared root node '${lock.root}' is missing; no locks written`,
      })
    }
    const inputs = declaredRoot['inputs']
    const rootInputs =
      inputs === undefined
        ? {}
        : yield* Schema.decodeUnknownEffect(Schema.Record(Schema.String, Schema.Unknown))(inputs)
    const nodeId =
      rootInputs[input] === undefined
        ? undefined
        : resolveLockInputNode({ ...lock, inputName: input })
    if (rootInputs[input] !== undefined && nodeId === undefined) {
      return yield* new StandaloneLockSyncError({
        path,
        input,
        message: `Input '${input}' cannot be resolved; no locks written`,
      })
    }
    const updates: Record<string, Record<string, unknown>> = {}
    let referencesInput = false
    for (const [candidateId, node] of Object.entries(lock.nodes)) {
      const sameOriginal =
        isDeepStrictEqual(withoutDir(node['original']), sourceOriginal) ||
        (ref !== undefined && isDeepStrictEqual(withoutDir(node['original']), desiredOriginal))
      const repository = inputRepositoryUrl(node['locked']) ?? inputRepositoryUrl(node['original'])
      if (
        candidateId !== nodeId &&
        sameOriginal === false &&
        (repository === undefined ||
          urlsMatch({ url1: repository, url2: sourceRepository }) === false)
      )
        continue
      if (sameOriginal === false) {
        return yield* new StandaloneLockSyncError({
          path,
          input,
          message: `Lock '${relative}': node '${candidateId}' for input '${input}' has a different original; no locks written`,
        })
      }
      referencesInput = true
      const original = node['original']
      const dir = Schema.is(InputMetadata)(original) === true ? original['dir'] : undefined
      const locked = dir === undefined ? sourceLocked : { ...sourceLocked, dir }
      const nextOriginal =
        ref === undefined ? original : { ...(yield* Schema.decodeUnknownEffect(InputMetadata)(original)), ref }
      if (isDeepStrictEqual(node['locked'], locked) === true &&
          isDeepStrictEqual(original, nextOriginal) === true) continue
      // Keep the graph and unknown metadata while aligning branch intent and resolution.
      updates[candidateId] = { ...node, original: nextOriginal, locked }
    }
    if (referencesInput === false) continue
    checked.push(relative)
    if (Object.keys(updates).length === 0) continue
    const updated = { ...lock, nodes: { ...lock.nodes, ...updates } }
    plans.push({ path, content: `${yield* Schema.encodeEffect(LockJson)(updated)}\n` })
  }

  if (write === true) {
    // Preflight the whole cohort before the first write, including symlinked file destinations.
    const authorized = yield* Effect.forEach(plans, (plan) =>
      Effect.gen(function* () {
        const physicalRoot = yield* fs.realPath(root)
        const physicalPath = yield* fs.realPath(plan.path)
        if (physicalPath.startsWith(`${physicalRoot}/`) === false) {
          return yield* new StandaloneLockSyncError({
            path: plan.path,
            input,
            message: 'Standalone lock resolves outside the consumer repository; no locks written',
          })
        }
        return yield* authorizeAuthorWorkspaceWrite({ target: plan.path, workspaceRoot: root })
      }),
    )
    yield* Effect.scoped(
      Effect.gen(function* () {
        // Stage the complete cohort and retain the original inodes before replacing anything.
        const staged = yield* Effect.forEach(plans, (plan, index) =>
          Effect.gen(function* () {
            const path = authorized[index]!
            const directory = yield* fs.makeTempDirectoryScoped({
              directory: dirname(path),
              prefix: '.mr-lock-sync-',
            })
            const replacement = `${directory}/replacement`
            const backup = `${directory}/original`
            yield* fs.writeFileString(replacement, plan.content)
            yield* fs.link(path, backup)
            return { path, replacement, backup }
          }),
        )
        const committed: typeof staged = []
        yield* Effect.forEach(staged, (plan) =>
          fs.rename(plan.replacement, plan.path).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                committed.push(plan)
              }),
            ),
          ),
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isFailure(exit) === true
              ? Effect.forEach(committed.toReversed(), (plan) =>
                  fs.rename(plan.backup, plan.path),
                ).pipe(Effect.orDie)
              : Effect.void,
          ),
          Effect.uninterruptible,
        )
      }),
    )
  }
  return { checked, changed: plans.map((plan) => plan.path.slice(root.length + 1)) }
})
