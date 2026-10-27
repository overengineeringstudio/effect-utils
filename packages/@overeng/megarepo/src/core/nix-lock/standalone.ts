import { isDeepStrictEqual } from 'node:util'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath } from '@overeng/effect-path'

import { writeFileAtomic } from '../../store/store-fs-atomic.ts'
import { authorizeAuthorWorkspaceWrite } from '../../store/store-path.ts'
import { runCommand } from '../git.ts'
import { extractLockFileInputs, resolveLockInputNode } from './input-discovery.ts'
import { urlsMatch } from './matcher.ts'
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
  write = false,
}: {
  root: string
  input: string
  rootLock?: 'devenv.lock' | 'flake.lock'
  write?: boolean
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

  const files = yield* runCommand({
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
  })
  const plans: Array<{ path: string; content: string }> = []
  const checked: string[] = []
  // A set avoids duplicate tracked/untracked results; git excludes ignored caches and member mounts.
  for (const relative of [...new Set(files.split('\0').filter((path) => path !== ''))].toSorted()) {
    if (relative === rootLock) continue
    const path = `${root}/${relative}`
    // Tracked files removed from the worktree are not standalone locks in this consumer.
    if ((yield* fs.exists(path)) === false) continue
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
      const sameOriginal = isDeepStrictEqual(node['original'], sourceNode['original'])
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
          message: `Node '${candidateId}' for input '${input}' has a different original; no locks written`,
        })
      }
      referencesInput = true
      if (isDeepStrictEqual(node['locked'], discovered.locked) === true) continue
      // Keep local graph edges; only the resolved source metadata comes from the root.
      updates[candidateId] = { ...node, locked: discovered.locked }
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
    for (const [index, plan] of plans.entries()) {
      yield* writeFileAtomic({
        path: EffectPath.unsafe.absoluteFile(authorized[index]!),
        content: plan.content,
      })
    }
  }
  return { checked, changed: plans.map((plan) => plan.path.slice(root.length + 1)) }
})
