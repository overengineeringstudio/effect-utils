/**
 * Nix Lock File Sync
 *
 * Synchronizes flake.lock and devenv.lock files in megarepo members
 * to match the commits tracked in megarepo.lock.
 *
 * This ensures all lock files stay in sync with megarepo as the single
 * source of truth for dependency versions.
 */

import {
  Command,
  type CommandExecutor,
  FileSystem,
  type Error as PlatformError,
} from '@effect/platform'
import { Effect, Schema, type ParseResult } from 'effect'

import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import { getMemberPath, type MegarepoConfig } from '../config.ts'
import type { LockFile, LockedMember } from '../lock.ts'
import { matchLockedInputToMember, needsRevUpdate } from './matcher.ts'
import {
  FlakeLock,
  updateLockedInputRev,
  updateLockedInputRevWithMetadata,
  type NixFlakeMetadata,
} from './schema.ts'

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
// Nix Metadata Fetching
// =============================================================================

/** Schema for nix flake prefetch JSON output */
const NixFlakePrefetchOutput = Schema.Struct({
  hash: Schema.String,
  locked: Schema.Struct({
    lastModified: Schema.Number,
    owner: Schema.optional(Schema.String),
    repo: Schema.optional(Schema.String),
    rev: Schema.String,
    type: Schema.String,
  }),
})

/**
 * Fetch metadata (narHash, lastModified) for a GitHub flake input.
 *
 * Uses `nix flake prefetch` to get the correct hash and timestamp for the revision.
 */
export const fetchNixFlakeMetadata = ({
  owner,
  repo,
  rev,
}: {
  owner: string
  repo: string
  rev: string
}): Effect.Effect<NixFlakeMetadata, PlatformError.PlatformError | ParseResult.ParseError, CommandExecutor.CommandExecutor> =>
  Effect.gen(function* () {
    const flakeRef = `github:${owner}/${repo}/${rev}`

    const command = Command.make('nix', 'flake', 'prefetch', flakeRef, '--json')
    const result = yield* Command.string(command)

    const json = JSON.parse(result) as unknown
    const parsed = yield* Schema.decodeUnknown(NixFlakePrefetchOutput)(json)

    return {
      narHash: parsed.hash,
      lastModified: parsed.locked.lastModified,
    }
  }).pipe(
    Effect.withSpan('fetchNixFlakeMetadata', { attributes: { owner, repo, rev } }),
  )

/**
 * Build a flake reference URL from locked input data.
 * Returns undefined if the locked input is not a type we can fetch metadata for.
 */
const getFlakeRefFromLocked = (
  locked: Record<string, unknown>,
): { owner: string; repo: string } | undefined => {
  const type = locked['type']

  if (type === 'github') {
    const owner = locked['owner']
    const repo = locked['repo']
    if (typeof owner === 'string' && typeof repo === 'string') {
      return { owner, repo }
    }
  }

  // For git type, try to extract owner/repo from GitHub URL
  if (type === 'git') {
    const url = locked['url']
    if (typeof url === 'string' && url.includes('github.com')) {
      const match = url.match(/github\.com[/:]([^/]+)\/([^/.]+)/)
      if (match?.[1] && match[2]) {
        return { owner: match[1], repo: match[2] }
      }
    }
  }

  return undefined
}

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
/**
 * Update a node object in-place, preserving the original key order.
 * Returns a new object with the same key order but updated locked field.
 */
const updateNodePreservingOrder = ({
  node,
  newLocked,
}: {
  node: Record<string, unknown>
  newLocked: Record<string, unknown>
}): Record<string, unknown> => {
  const result: Record<string, unknown> = {}

  // Preserve original key order
  for (const key of Object.keys(node)) {
    if (key === 'locked') {
      result['locked'] = newLocked
    } else {
      result[key] = node[key]
    }
  }

  return result
}

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
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Read and parse the lock file
    const content = yield* fs.readFileString(lockPath)
    // Keep raw JSON for preserving key order
    const rawJson = JSON.parse(content) as {
      nodes: Record<string, Record<string, unknown>>
      root: string
      version: number
    }

    // Validate schema (but we'll work with rawJson to preserve order)
    yield* Schema.decodeUnknown(FlakeLock)(rawJson)

    const updatedInputs: NixLockSyncFileResult['updatedInputs'][number][] = []

    // Process each node in the lock file (using rawJson to preserve order)
    for (const [nodeName, node] of Object.entries(rawJson.nodes)) {
      const locked = node['locked'] as Record<string, unknown> | undefined

      // Skip nodes without locked data (e.g., root node)
      if (!locked) {
        continue
      }

      // Try to match this input to a megarepo member
      const match = matchLockedInputToMember({ locked, members: megarepoMembers })

      if (match && needsRevUpdate({ locked, member: match.member })) {
        // Found a match and rev differs - update it
        const oldRev = typeof locked['rev'] === 'string' ? locked['rev'] : 'unknown'
        const newRev = match.member.commit

        updatedInputs.push({
          inputName: nodeName,
          memberName: match.memberName,
          oldRev,
          newRev,
        })

        // Try to fetch metadata for the new revision
        const flakeRef = getFlakeRefFromLocked(locked)
        let newLocked: Record<string, unknown>

        if (flakeRef) {
          // Fetch proper metadata from Nix
          const metadataResult = yield* fetchNixFlakeMetadata({
            owner: flakeRef.owner,
            repo: flakeRef.repo,
            rev: newRev,
          }).pipe(
            Effect.tapError((e) =>
              Effect.logWarning(
                `Failed to fetch Nix metadata for ${flakeRef.owner}/${flakeRef.repo}@${newRev}: ${e}`,
              ),
            ),
            Effect.option,
          )

          if (metadataResult._tag === 'Some') {
            // Use the fetched metadata
            newLocked = updateLockedInputRevWithMetadata({ locked, newRev, metadata: metadataResult.value })
          } else {
            // Fallback: update rev without metadata (will be incomplete)
            yield* Effect.logWarning(
              `Using incomplete lock entry for ${nodeName} (missing narHash/lastModified)`,
            )
            newLocked = updateLockedInputRev({ locked, newRev })
          }
        } else {
          // Non-GitHub input, can't fetch metadata
          newLocked = updateLockedInputRev({ locked, newRev })
        }

        // Update node in-place, preserving key order
        rawJson.nodes[nodeName] = updateNodePreservingOrder({ node, newLocked })
      }
    }

    // Write updated lock file if any changes were made
    if (updatedInputs.length > 0) {
      const updatedContent = JSON.stringify(rawJson, null, 2)
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

export {
  FlakeLock,
  FlakeLockNode,
  updateLockedInputRev,
  updateLockedInputRevWithMetadata,
  parseLockedInput,
  type NixFlakeMetadata,
} from './schema.ts'
export {
  matchLockedInputToMember,
  needsRevUpdate,
  normalizeGitHubUrl,
  normalizeGitUrl,
  urlsMatch,
} from './matcher.ts'
