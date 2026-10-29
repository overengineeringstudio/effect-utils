import { dirname, isAbsolute, normalize } from 'node:path'
import { isDeepStrictEqual } from 'node:util'

import { Effect, Exit, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import { authorizeAuthorWorkspaceWrite } from '../../store/store-path.ts'
import { runCommand } from '../git.ts'
import { extractLockFileInputs, resolveLockInputNode } from './input-discovery.ts'
import { urlsMatch } from './matcher.ts'
import { fetchNixFlakeMetadata } from './mod.ts'
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
}: {
  root: string
  input: string
  rootLock?: 'devenv.lock' | 'flake.lock'
  locks?: ReadonlyArray<string>
  write?: boolean
  rev?: string
}) {
  const fs = yield* FileSystem.FileSystem
  const root = rootPath.replace(/\/$/, '')
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
  if (rev !== undefined) {
    const tracking = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        type: Schema.Literal('github'),
        owner: Schema.NonEmptyString,
        repo: Schema.NonEmptyString,
        ref: Schema.NonEmptyString,
        rev: Schema.optional(Schema.String),
      }),
    )(sourceOriginal).pipe(
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
              tracking.ref,
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
  const plans: Array<{ path: string; content: string }> = []
  const checked: string[] = []
  if (rev !== undefined) {
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
  for (const relative of [...new Set(files)].toSorted()) {
    if (relative === rootLock) continue
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
      const sameOriginal = isDeepStrictEqual(withoutDir(node['original']), sourceOriginal)
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
      if (isDeepStrictEqual(node['locked'], locked) === true) continue
      // Keep the complete original and graph; only source metadata is shared between subflakes.
      updates[candidateId] = { ...node, locked }
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
