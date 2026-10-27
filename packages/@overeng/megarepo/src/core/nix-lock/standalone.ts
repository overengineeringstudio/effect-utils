import { isDeepStrictEqual } from 'node:util'

import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { authorizeAuthorWorkspaceWrite } from '../../store/store-path.ts'
import { runCommand } from '../git.ts'
import { extractLockFileInputs, resolveLockInputNode } from './input-discovery.ts'

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
  if (discovered === undefined || sourceNode?.['original'] === undefined) {
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
    const inputs = lock.nodes[lock.root]?.['inputs']
    if (inputs === undefined) continue
    const rootInputs = yield* Schema.decodeUnknownEffect(
      Schema.Record(Schema.String, Schema.Unknown),
    )(inputs)
    if (rootInputs[input] === undefined) continue
    const nodeId = resolveLockInputNode({ ...lock, inputName: input })
    const node = nodeId === undefined ? undefined : lock.nodes[nodeId]
    if (
      nodeId === undefined ||
      node === undefined ||
      isDeepStrictEqual(node['original'], sourceNode['original']) === false
    ) {
      return yield* new StandaloneLockSyncError({
        path,
        input,
        message: `Input '${input}' has a different original or cannot be resolved; no locks written`,
      })
    }
    checked.push(relative)
    if (isDeepStrictEqual(node['locked'], discovered.locked) === true) continue
    // Copy the complete resolved metadata, never re-resolve a moving ref or copy foreign graph edges.
    const updated = {
      ...lock,
      nodes: { ...lock.nodes, [nodeId]: { ...node, locked: discovered.locked } },
    }
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
      yield* fs.writeFileString(authorized[index]!, plan.content)
    }
  }
  return { checked, changed: plans.map((plan) => plan.path.slice(root.length + 1)) }
})
