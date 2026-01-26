/**
 * Nix Lock File Sync
 *
 * Synchronizes flake.lock and devenv.lock files in megarepo members
 * to match the commits tracked in megarepo.lock.
 *
 * This ensures all lock files stay in sync with megarepo as the single
 * source of truth for dependency versions.
 */

import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Schema, type ParseResult } from 'effect'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { getMemberPath, type MegarepoConfig } from '../config.ts'
import type { LockFile, LockedMember } from '../lock.ts'
import { matchLockedInputToMember, needsRevUpdate } from './matcher.ts'
import { FlakeLock, updateLockedInputRev } from './schema.ts'

// =============================================================================
// Types
// =============================================================================

/** Result of syncing a single Nix lock file */
export interface NixLockSyncFileResult {
  /** Path to the lock file */
  readonly path: AbsoluteFilePath
  /** Type of lock file (flake.lock or devenv.lock) */
  readonly type: 'flake.lock' | 'devenv.lock'
  /** Inputs that were updated */
  readonly updatedInputs: ReadonlyArray<{
    /** Name of the input in the flake.lock */
    readonly inputName: string
    /** Name of the megarepo member this input maps to */
    readonly memberName: string
    /** Previous revision */
    readonly oldRev: string
    /** New revision from megarepo.lock */
    readonly newRev: string
  }>
}

/** Result of syncing all Nix lock files in a megarepo */
export interface NixLockSyncResult {
  /** Member repos that had lock files synced */
  readonly memberResults: ReadonlyArray<{
    /** Name of the megarepo member */
    readonly memberName: string
    /** Lock files synced in this member */
    readonly files: ReadonlyArray<NixLockSyncFileResult>
  }>
  /** Total number of inputs updated across all files */
  readonly totalUpdates: number
}

/** Options for syncing Nix lock files */
export interface NixLockSyncOptions {
  /** Path to the megarepo root */
  readonly megarepoRoot: AbsoluteDirPath
  /** Megarepo configuration */
  readonly config: typeof MegarepoConfig.Type
  /** Megarepo lock file with resolved commits */
  readonly lockFile: LockFile
  /** Members to exclude from sync (opt-out) */
  readonly excludeMembers?: ReadonlySet<string>
}

// =============================================================================
// Lock File Names
// =============================================================================

const FLAKE_LOCK = 'flake.lock'
const DEVENV_LOCK = 'devenv.lock'

// =============================================================================
// Single Lock File Sync
// =============================================================================

/**
 * Sync a single flake.lock or devenv.lock file
 *
 * For each input in the lock file:
 * 1. Try to match it to a megarepo member by URL
 * 2. If matched and rev differs, update to megarepo.lock commit
 * 3. Remove narHash and lastModified (they'd be invalid after rev change)
 */
const syncSingleLockFile = ({
  lockPath,
  lockType,
  megarepoMembers,
}: {
  lockPath: AbsoluteFilePath
  lockType: 'flake.lock' | 'devenv.lock'
  megarepoMembers: Record<string, LockedMember>
}): Effect.Effect<
  NixLockSyncFileResult,
  PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Read and parse the lock file
    const content = yield* fs.readFileString(lockPath)
    const json = JSON.parse(content) as unknown
    const flakeLock = yield* Schema.decodeUnknown(FlakeLock)(json)

    const updatedInputs: NixLockSyncFileResult['updatedInputs'][number][] = []
    const updatedNodes: Record<string, typeof flakeLock.nodes[string]> = {}

    // Process each node in the lock file
    for (const [nodeName, node] of Object.entries(flakeLock.nodes)) {
      // Skip the root node (it doesn't have locked data)
      if (!node.locked) {
        updatedNodes[nodeName] = node
        continue
      }

      // Try to match this input to a megarepo member
      const match = matchLockedInputToMember(node.locked, megarepoMembers)

      if (match && needsRevUpdate(node.locked, match.member)) {
        // Found a match and rev differs - update it
        const oldRev =
          typeof node.locked['rev'] === 'string' ? node.locked['rev'] : 'unknown'
        const newRev = match.member.commit

        updatedInputs.push({
          inputName: nodeName,
          memberName: match.memberName,
          oldRev,
          newRev,
        })

        // Create updated node with new rev, without narHash/lastModified
        updatedNodes[nodeName] = {
          ...node,
          locked: updateLockedInputRev(node.locked, newRev),
        }
      } else {
        // No match or no update needed - keep as-is
        updatedNodes[nodeName] = node
      }
    }

    // Write updated lock file if any changes were made
    if (updatedInputs.length > 0) {
      const updatedFlakeLock: typeof FlakeLock.Type = {
        ...flakeLock,
        nodes: updatedNodes,
      }
      const updatedContent = JSON.stringify(
        Schema.encodeSync(FlakeLock)(updatedFlakeLock),
        null,
        2,
      )
      yield* fs.writeFileString(lockPath, updatedContent + '\n')
    }

    return {
      path: lockPath,
      type: lockType,
      updatedInputs,
    }
  })

// =============================================================================
// Main Sync Function
// =============================================================================

/**
 * Sync all Nix lock files in megarepo members
 *
 * Scans each member for flake.lock and devenv.lock files,
 * and updates any inputs that match other megarepo members
 * to use the commits from megarepo.lock.
 */
export const syncNixLocks = Effect.fn('megarepo/nix-lock/sync')(
  (options: NixLockSyncOptions) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const excludeMembers = options.excludeMembers ?? new Set()

      // Build a map of megarepo member URLs to their locked data
      const megarepoMembers = options.lockFile.members

      const memberResults: NixLockSyncResult['memberResults'][number][] = []
      let totalUpdates = 0

      // Process each member in the megarepo
      for (const memberName of Object.keys(options.config.members)) {
        // Skip excluded members
        if (excludeMembers.has(memberName)) {
          continue
        }

        const memberPath = getMemberPath({
          megarepoRoot: options.megarepoRoot,
          name: memberName,
        })

        // Check if member directory exists
        const memberExists = yield* fs.exists(memberPath)
        if (!memberExists) {
          continue
        }

        const files: NixLockSyncFileResult[] = []

        // Check for flake.lock
        const flakeLockPath = EffectPath.ops.join(
          memberPath,
          EffectPath.unsafe.relativeFile(FLAKE_LOCK),
        )
        const hasFlakeLock = yield* fs.exists(flakeLockPath)
        if (hasFlakeLock) {
          const result = yield* syncSingleLockFile({
            lockPath: flakeLockPath,
            lockType: 'flake.lock',
            megarepoMembers,
          }).pipe(
            Effect.catchTag('ParseError', (e) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Failed to parse ${flakeLockPath}: ${e.message}`,
                )
                return {
                  path: flakeLockPath,
                  type: 'flake.lock' as const,
                  updatedInputs: [],
                }
              }),
            ),
          )
          if (result.updatedInputs.length > 0) {
            files.push(result)
            totalUpdates += result.updatedInputs.length
          }
        }

        // Check for devenv.lock
        const devenvLockPath = EffectPath.ops.join(
          memberPath,
          EffectPath.unsafe.relativeFile(DEVENV_LOCK),
        )
        const hasDevenvLock = yield* fs.exists(devenvLockPath)
        if (hasDevenvLock) {
          const result = yield* syncSingleLockFile({
            lockPath: devenvLockPath,
            lockType: 'devenv.lock',
            megarepoMembers,
          }).pipe(
            Effect.catchTag('ParseError', (e) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Failed to parse ${devenvLockPath}: ${e.message}`,
                )
                return {
                  path: devenvLockPath,
                  type: 'devenv.lock' as const,
                  updatedInputs: [],
                }
              }),
            ),
          )
          if (result.updatedInputs.length > 0) {
            files.push(result)
            totalUpdates += result.updatedInputs.length
          }
        }

        if (files.length > 0) {
          memberResults.push({ memberName, files })
        }
      }

      return {
        memberResults,
        totalUpdates,
      } satisfies NixLockSyncResult
    }),
)

// =============================================================================
// Re-exports
// =============================================================================

export { FlakeLock, FlakeLockNode, updateLockedInputRev, parseLockedInput } from './schema.ts'
export {
  matchLockedInputToMember,
  needsRevUpdate,
  normalizeGitHubUrl,
  normalizeGitUrl,
  urlsMatch,
} from './matcher.ts'
