/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import type { CommandExecutor } from '@effect/platform'
import { Command, FileSystem, type Error as PlatformError } from '@effect/platform'
import { Console, Context, Effect, Fiber, Layer, Option, type ParseResult, Schema, Stream, SubscriptionRef } from 'effect'

import {
  createProgressListState,
  finishProgressList,
  formatElapsed,
  isTTY,
  kv,
  markActive,
  markError,
  markSuccess,
  separator,
  startProgressList,
  startSpinner,
  styled,
  symbols,
  updateProgressList,
} from '@overeng/cli-ui'
import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'
import { jsonError, withJsonMode } from '@overeng/utils/node'

import {
  CONFIG_FILE_NAME,
  ENV_VARS,
  getMemberPath,
  getMembersRoot,
  getSourceRef,
  getSourceUrl,
  isRemoteSource,
  MegarepoConfig,
  MEMBER_ROOT_DIR,
  type MemberSource,
  parseSourceString,
  validateMemberName,
} from '../lib/config.ts'
import { generateNix, type NixGeneratorError } from '../lib/generators/nix/mod.ts'
import { generateSchema } from '../lib/generators/schema.ts'
import { generateVscode } from '../lib/generators/vscode.ts'
import * as Git from '../lib/git.ts'
import { MR_VERSION } from '../lib/version.ts'
import {
  checkLockStaleness,
  createEmptyLockFile,
  createLockedMember,
  getLockedMember,
  type LockFile,
  LOCK_FILE_NAME,
  pinMember,
  readLockFile,
  syncLockWithConfig,
  unpinMember,
  upsertLockedMember,
  writeLockFile,
} from '../lib/lock.ts'
import { classifyRef } from '../lib/ref.ts'
import { Store, StoreLayer } from '../lib/store.ts'
import {
  outputLines,
  renderStatus,
  renderSync,
  type MemberStatus,
  type GitStatus,
} from './renderers/mod.ts'
import {
  SyncProgress,
  SyncProgressEmpty,
  setMemberSyncing,
  applySyncResult,
  completeSyncProgress,
  startSyncProgressUI,
  finishSyncProgressUI,
  type SyncProgressService,
} from './progress/mod.ts'

// =============================================================================
// CLI Context Services
// =============================================================================

/**
 * Current working directory service.
 *
 * Uses $PWD environment variable when available to preserve the logical path
 * through symlinks. This is important for megarepo because members are symlinked
 * from the workspace into the store - when running commands from inside a member,
 * we need to find the workspace's megarepo.json, not walk up from the store path.
 *
 * - $PWD: logical path (preserves symlinks) - set by the shell
 * - process.cwd(): physical path (resolves symlinks)
 */
export class Cwd extends Context.Tag('megarepo/Cwd')<Cwd, AbsoluteDirPath>() {
  static live = Layer.effect(
    Cwd,
    Effect.sync(() => {
      // Prefer $PWD (logical path) over process.cwd() (physical path)
      // to support running commands from inside symlinked members
      const pwd = process.env.PWD
      const cwd = pwd !== undefined && pwd.length > 0 ? pwd : process.cwd()
      return EffectPath.unsafe.absoluteDir(cwd.endsWith('/') ? cwd : `${cwd}/`)
    }),
  )
}

// =============================================================================
// Common Options
// =============================================================================

/** JSON output format option */
const jsonOption = Cli.Options.boolean('json').pipe(
  Cli.Options.withDescription('Output in JSON format'),
  Cli.Options.withDefault(false),
)

/**
 * Create a symlink, stripping trailing slashes from paths.
 * POSIX symlink fails with ENOENT if the link path ends with `/`.
 */
const createSymlink = ({ target, link }: { target: string; link: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.symlink(target.replace(/\/$/, ''), link.replace(/\/$/, ''))
  })

// =============================================================================
// Init Command
// =============================================================================

/** Initialize a new megarepo in current directory */
const initCommand = Cli.Command.make('init', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const fs = yield* FileSystem.FileSystem

    // Check if already in a git repo
    const isGit = yield* Git.isGitRepo(cwd)
    if (!isGit) {
      if (json) {
        return yield* jsonError({ error: 'not_git_repo', message: 'Not a git repository' })
      }
      yield* Console.error(
        `${styled.red(symbols.cross)} Not a git repository. Run 'git init' first.`,
      )
      return yield* Effect.fail(new Error('Not a git repository'))
    }

    const configPath = EffectPath.ops.join(cwd, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME))

    // Check if config already exists
    const exists = yield* fs.exists(configPath)
    if (exists) {
      if (json) {
        console.log(JSON.stringify({ status: 'already_initialized', path: configPath }))
      } else {
        yield* Console.log(styled.dim('megarepo already initialized'))
      }
      return
    }

    // Create initial config
    const initialConfig = {
      $schema:
        'https://raw.githubusercontent.com/overengineeringstudio/megarepo/main/schema/megarepo.schema.json',
      members: {},
    }

    const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
      initialConfig,
    )
    yield* fs.writeFileString(configPath, configContent + '\n')

    if (json) {
      console.log(JSON.stringify({ status: 'initialized', path: configPath }))
    } else {
      yield* Console.log(
        `${styled.green(symbols.check)} ${styled.dim('initialized megarepo at')} ${styled.bold(path.basename(cwd))}`,
      )
    }
  }).pipe(Effect.withSpan('megarepo/init'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Initialize a new megarepo in the current directory'))

// =============================================================================
// Root Command
// =============================================================================

/**
 * Find megarepo root by searching up from current directory.
 * Returns the OUTERMOST megarepo found (closest to filesystem root).
 * This ensures "outer wins" behavior for nested megarepos.
 */
const findMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current: AbsoluteDirPath | undefined = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')
    let outermost: AbsoluteDirPath | undefined = undefined

    // Walk up the tree, collecting the outermost megarepo found
    while (current !== undefined && current !== rootDir) {
      const configPath = EffectPath.ops.join(
        current,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const exists = yield* fs.exists(configPath)
      if (exists) {
        outermost = current // Keep going up, this might not be the outermost
      }
      current = EffectPath.ops.parent(current)
    }

    // Check root as well
    const rootConfigPath = EffectPath.ops.join(
      rootDir,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const rootExists = yield* fs.exists(rootConfigPath)
    if (rootExists) {
      outermost = rootDir
    }

    return Option.fromNullable(outermost)
  })

/**
 * Find the nearest megarepo root by searching up from current directory.
 * Returns the closest megarepo found (nearest to start path).
 */
const findNearestMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current: AbsoluteDirPath | undefined = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')

    while (current !== undefined && current !== rootDir) {
      const configPath = EffectPath.ops.join(
        current,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const exists = yield* fs.exists(configPath)
      if (exists) {
        return Option.some(current)
      }
      current = EffectPath.ops.parent(current)
    }

    const rootConfigPath = EffectPath.ops.join(
      rootDir,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const rootExists = yield* fs.exists(rootConfigPath)
    return rootExists ? Option.some(rootDir) : Option.none()
  })

/** Find and print the megarepo root directory */
const rootCommand = Cli.Command.make('root', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd

    // Search up from current directory
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        return yield* jsonError({ error: 'not_found', message: 'No megarepo.json found' })
      }
      yield* Console.error(
        `${styled.red(symbols.cross)} No megarepo.json found in current directory or any parent.`,
      )
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    const name = yield* Git.deriveMegarepoName(root.value)

    if (json) {
      console.log(JSON.stringify({ root: root.value, name, source: 'search' }))
    } else {
      yield* Console.log(root.value)
    }
  }).pipe(Effect.withSpan('megarepo/root'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Print the megarepo root directory'))

// =============================================================================
// Env Command
// =============================================================================

/** Print environment variables for shell integration */
const envCommand = Cli.Command.make(
  'env',
  {
    shell: Cli.Options.choice('shell', ['bash', 'zsh', 'fish']).pipe(
      Cli.Options.withDescription('Shell type for output format'),
      Cli.Options.withDefault('bash' as const),
    ),
    json: jsonOption,
  },
  ({ shell, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd

      // Find the megarepo root
      const root = yield* findMegarepoRoot(cwd)
      const nearestRoot = yield* findNearestMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          return yield* jsonError({ error: 'not_found', message: 'No megarepo.json found' })
        }
        yield* Console.error(`${styled.red(symbols.cross)} No megarepo.json found`)
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config to get member names
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      const memberNames = Object.keys(config.members).join(',')

      if (json) {
        console.log(
          JSON.stringify({
            [ENV_VARS.ROOT_OUTERMOST]: root.value,
            [ENV_VARS.ROOT_NEAREST]: Option.getOrElse(nearestRoot, () => root.value),
            [ENV_VARS.MEMBERS]: memberNames,
          }),
        )
      } else {
        // Output shell-specific format
        switch (shell) {
          case 'fish':
            yield* Console.log(`set -gx ${ENV_VARS.ROOT_OUTERMOST} "${root.value}"`)
            yield* Console.log(
              `set -gx ${ENV_VARS.ROOT_NEAREST} "${Option.getOrElse(nearestRoot, () => root.value)}"`,
            )
            yield* Console.log(`set -gx ${ENV_VARS.MEMBERS} "${memberNames}"`)
            break
          default:
            yield* Console.log(`export ${ENV_VARS.ROOT_OUTERMOST}="${root.value}"`)
            yield* Console.log(
              `export ${ENV_VARS.ROOT_NEAREST}="${Option.getOrElse(nearestRoot, () => root.value)}"`,
            )
            yield* Console.log(`export ${ENV_VARS.MEMBERS}="${memberNames}"`)
        }
      }
    }).pipe(Effect.withSpan('megarepo/env'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Output environment variables for shell integration'))

// =============================================================================
// Status Command
// =============================================================================

/**
 * Recursively scan members and build status tree.
 * @param megarepoRoot - Root path of the megarepo
 * @param visited - Set of visited paths to prevent cycles
 */
const scanMembersRecursive = ({
  megarepoRoot,
  visited = new Set<string>(),
}: {
  megarepoRoot: AbsoluteDirPath
  visited?: Set<string>
}): Effect.Effect<
  MemberStatus[],
  PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Prevent cycles
    const normalizedRoot = megarepoRoot.replace(/\/$/, '')
    if (visited.has(normalizedRoot)) {
      return []
    }
    visited.add(normalizedRoot)

    // Load config
    const configPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configExists = yield* fs.exists(configPath)
    if (!configExists) {
      return []
    }

    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    // Load lock file (optional)
    const lockPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFileOpt = yield* readLockFile(lockPath)
    const lockFile = Option.getOrUndefined(lockFileOpt)

    // Build member status list
    const members: MemberStatus[] = []
    for (const [memberName, sourceString] of Object.entries(config.members)) {
      const memberPath = getMemberPath({ megarepoRoot, name: memberName })
      const memberExists = yield* fs.exists(memberPath)
      const source = parseSourceString(sourceString)
      const isLocal = source?.type === 'path'
      const lockedMember = lockFile?.members[memberName]

      // Check if this member is itself a megarepo
      const nestedConfigPath = EffectPath.ops.join(
        memberPath,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const isMegarepo = memberExists
        ? yield* fs.exists(nestedConfigPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
        : false

      // Recursively scan nested members if this is a megarepo
      let nestedMembers: readonly MemberStatus[] | undefined = undefined
      if (isMegarepo && memberExists) {
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          memberPath.endsWith('/') ? memberPath : `${memberPath}/`,
        )
        nestedMembers = yield* scanMembersRecursive({ megarepoRoot: nestedRoot, visited })
      }

      // Get git status if member exists
      let gitStatus: GitStatus | undefined = undefined
      if (memberExists) {
        // Check if it's a git repo first
        const isGit = yield* Git.isGitRepo(memberPath).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        )
        if (isGit) {
          // Get worktree status (dirty, unpushed)
          const worktreeStatus = yield* Git.getWorktreeStatus(memberPath).pipe(
            Effect.catchAll(() =>
              Effect.succeed({ isDirty: false, hasUnpushed: false, changesCount: 0 }),
            ),
          )

          // Get current branch
          const branchOpt = yield* Git.getCurrentBranch(memberPath).pipe(
            Effect.catchAll(() => Effect.succeed(Option.none())),
          )
          const branch = Option.getOrElse(branchOpt, () => 'HEAD')

          // Get short rev
          const shortRev = yield* Git.getCurrentCommit(memberPath).pipe(
            Effect.map((commit) => commit.slice(0, 7)),
            Effect.catchAll(() => Effect.succeed(undefined)),
          )

          gitStatus = {
            isDirty: worktreeStatus.isDirty,
            changesCount: worktreeStatus.changesCount,
            hasUnpushed: worktreeStatus.hasUnpushed,
            branch,
            shortRev,
          }
        }
      }

      members.push({
        name: memberName,
        exists: memberExists,
        source: sourceString,
        isLocal,
        lockInfo: lockedMember
          ? {
              ref: lockedMember.ref,
              commit: lockedMember.commit,
              pinned: lockedMember.pinned,
            }
          : undefined,
        isMegarepo,
        nestedMembers,
        gitStatus,
      })
    }

    return members
  })

/** Show megarepo status */
const statusCommand = Cli.Command.make('status', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const fs = yield* FileSystem.FileSystem
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        return yield* jsonError({ error: 'not_found', message: 'No megarepo.json found' })
      }
      yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    const name = yield* Git.deriveMegarepoName(root.value)

    if (json) {
      // Load config for JSON output
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      console.log(
        JSON.stringify({
          name,
          root: root.value,
          memberCount: Object.keys(config.members).length,
          members: Object.keys(config.members),
        }),
      )
    } else {
      // Load config for staleness check
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Recursively scan all members
      const members = yield* scanMembersRecursive({ megarepoRoot: root.value })

      // Get last sync time and lock staleness from lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lastSyncTime: Date | undefined = undefined
      let lockStaleness: {
        exists: boolean
        missingFromLock: readonly string[]
        extraInLock: readonly string[]
      } | undefined = undefined

      // Determine which members are remote (need lock tracking)
      const remoteMemberNames = new Set<string>()
      for (const [memberName, sourceString] of Object.entries(config.members)) {
        const source = parseSourceString(sourceString)
        if (source !== undefined && isRemoteSource(source)) {
          remoteMemberNames.add(memberName)
        }
      }

      if (Option.isSome(lockFileOpt)) {
        // Find the most recent lockedAt timestamp across all members
        const timestamps = Object.values(lockFileOpt.value.members)
          .map((m) => new Date(m.lockedAt).getTime())
          .filter((t) => !Number.isNaN(t))
        if (timestamps.length > 0) {
          lastSyncTime = new Date(Math.max(...timestamps))
        }

        // Check staleness
        const staleness = checkLockStaleness({
          lockFile: lockFileOpt.value,
          configMemberNames: remoteMemberNames,
        })
        lockStaleness = {
          exists: true,
          missingFromLock: staleness.addedMembers,
          extraInLock: staleness.removedMembers,
        }
      } else if (remoteMemberNames.size > 0) {
        // Lock file doesn't exist but we have remote members
        lockStaleness = {
          exists: false,
          missingFromLock: [...remoteMemberNames],
          extraInLock: [],
        }
      }

      // Compute current member path (for highlighting current location)
      // We need to handle two cases:
      // 1. User is in repos/<member> path - use path-based detection
      // 2. User is in a convenience symlink - resolve and match against member targets
      const cwdNormalized = cwd.replace(/\/$/, '')
      const rootNormalized = root.value.replace(/\/$/, '')

      // First try path-based detection (handles repos/<member>/repos/<member>/... paths)
      let currentMemberPath: string[] | undefined = undefined
      if (cwdNormalized !== rootNormalized && cwdNormalized.startsWith(rootNormalized)) {
        const relativePath = cwdNormalized.slice(rootNormalized.length + 1)
        const parts = relativePath.split('/')
        const memberPath: string[] = []
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] === MEMBER_ROOT_DIR && i + 1 < parts.length) {
            memberPath.push(parts[i + 1]!)
            i++ // Skip the member name we just added
          }
        }
        if (memberPath.length > 0) {
          currentMemberPath = memberPath
        }
      }

      // If path-based detection didn't work, try symlink resolution
      // This handles convenience symlinks outside repos/ directory
      if (currentMemberPath === undefined) {
        const cwdRealPath = yield* fs.realPath(cwd).pipe(
          Effect.map((p) => p.replace(/\/$/, '')),
          Effect.catchAll(() => Effect.succeed(cwdNormalized)),
        )

        // Find which member (if any) the cwd is inside by matching against member symlink targets
        const findCurrentMemberPath = (
          memberList: readonly MemberStatus[],
          megarepoRoot: string,
          pathSoFar: string[],
        ): Effect.Effect<string[] | undefined, never, FileSystem.FileSystem> =>
          Effect.gen(function* () {
            for (const member of memberList) {
              const memberSymlinkPath = getMemberPath({
                megarepoRoot: EffectPath.unsafe.absoluteDir(megarepoRoot),
                name: member.name,
              })
              const memberRealPath = yield* fs.realPath(memberSymlinkPath.replace(/\/$/, '')).pipe(
                Effect.catchAll(() => Effect.succeed(undefined)),
              )

              if (memberRealPath !== undefined) {
                const memberRealPathNorm = memberRealPath.replace(/\/$/, '')
                // Check if cwd resolves to this member or inside it
                if (
                  cwdRealPath === memberRealPathNorm ||
                  cwdRealPath.startsWith(memberRealPathNorm + '/')
                ) {
                  const newPath = [...pathSoFar, member.name]
                  // If exact match, we found it
                  if (cwdRealPath === memberRealPathNorm) {
                    return newPath
                  }
                  // If inside, check nested members
                  if (member.nestedMembers && member.nestedMembers.length > 0) {
                    const nestedResult = yield* findCurrentMemberPath(
                      member.nestedMembers,
                      memberRealPathNorm + '/',
                      newPath,
                    )
                    if (nestedResult !== undefined) {
                      return nestedResult
                    }
                  }
                  // Inside this member but not in a nested megarepo
                  return newPath
                }
              }
            }
            return undefined
          })

        currentMemberPath = yield* findCurrentMemberPath(members, root.value, [])
      }

      // Render and output
      const lines = renderStatus({
        name,
        root: root.value,
        members,
        lastSyncTime,
        lockStaleness,
        currentMemberPath,
      })
      yield* outputLines(lines)
    }
  }).pipe(Effect.withSpan('megarepo/status'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('Show workspace status and member states'))

// =============================================================================
// Ls Command
// =============================================================================

/** List members */
const lsCommand = Cli.Command.make('ls', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        return yield* jsonError({ error: 'not_found', message: 'No megarepo.json found' })
      }
      yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    // Load config
    const fs = yield* FileSystem.FileSystem
    const configPath = EffectPath.ops.join(
      root.value,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    if (json) {
      console.log(JSON.stringify({ members: config.members }))
    } else {
      for (const [name, sourceString] of Object.entries(config.members)) {
        yield* Console.log(`${styled.bold(name)} ${styled.dim(`(${sourceString})`)}`)
      }
    }
  }).pipe(Effect.withSpan('megarepo/ls'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('List all members in the megarepo'))

// =============================================================================
// Sync Command
// =============================================================================

/** Member sync result */
interface MemberSyncResult {
  readonly name: string
  readonly status: 'cloned' | 'synced' | 'already_synced' | 'skipped' | 'error' | 'updated' | 'locked'
  readonly message?: string | undefined
  /** Resolved commit for lock file (remote sources only) */
  readonly commit?: string | undefined
  /** Previous commit (for showing changes) */
  readonly previousCommit?: string | undefined
  /** Resolved ref for lock file */
  readonly ref?: string | undefined
  /** Whether the lock was updated for this member */
  readonly lockUpdated?: boolean | undefined
}

/**
 * Get the git clone URL for a member source
 */
const getCloneUrl = (source: MemberSource): string | undefined => {
  switch (source.type) {
    case 'github':
      return `git@github.com:${source.owner}/${source.repo}.git`
    case 'url':
      return source.url
    case 'path':
      return undefined
  }
}

/**
 * Sync a single member: use bare repo + worktree pattern
 *
 * Modes:
 * - Default: ensure member exists, read current HEAD to update lock
 * - Pull: fetch from remote, update to latest (unless pinned)
 * - Frozen: use exact commit from lock, never modify lock
 */
const syncMember = ({
  name,
  sourceString,
  megarepoRoot,
  lockFile,
  dryRun,
  pull,
  frozen,
  force,
}: {
  name: string
  sourceString: string
  megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  dryRun: boolean
  pull: boolean
  frozen: boolean
  force: boolean
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store

    // Validate member name to prevent path traversal
    const nameError = validateMemberName(name)
    if (nameError !== undefined) {
      return {
        name,
        status: 'error',
        message: nameError,
      } satisfies MemberSyncResult
    }

    // Parse the source string
    const source = parseSourceString(sourceString)
    if (source === undefined) {
      return {
        name,
        status: 'error',
        message: `Invalid source string: ${sourceString}`,
      } satisfies MemberSyncResult
    }

    const memberPath = getMemberPath({ megarepoRoot, name })
    const memberPathNormalized = memberPath.replace(/\/$/, '')

    // Handle local path sources - just create symlink
    if (source.type === 'path') {
      const expandedPath = source.path.replace(/^~/, process.env.HOME ?? '~')
      const resolvedPath = path.isAbsolute(expandedPath)
        ? expandedPath
        : path.resolve(megarepoRoot, expandedPath)
      const existingLink = yield* fs
        .readLink(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(null)))

      if (existingLink !== null) {
        if (existingLink.replace(/\/$/, '') === resolvedPath.replace(/\/$/, '')) {
          return { name, status: 'already_synced' } satisfies MemberSyncResult
        }
        if (!dryRun) {
          yield* fs.remove(memberPathNormalized)
        }
      } else {
        const exists = yield* fs
          .exists(memberPathNormalized)
          .pipe(Effect.catchAll(() => Effect.succeed(false)))
        if (exists) {
          return {
            name,
            status: 'skipped',
            message: 'Directory exists but is not a symlink',
          } satisfies MemberSyncResult
        }
      }

      if (!dryRun) {
        yield* createSymlink({ target: resolvedPath, link: memberPathNormalized })
      }

      return { name, status: 'synced' } satisfies MemberSyncResult
    }

    // For remote sources, use bare repo + worktree pattern
    const cloneUrl = getCloneUrl(source)
    if (cloneUrl === undefined) {
      return { name, status: 'error', message: 'Cannot get clone URL' } satisfies MemberSyncResult
    }

    const bareRepoPath = store.getBareRepoPath(source)
    const bareExists = yield* store.hasBareRepo(source)

    // Determine which ref to use
    let targetRef: string
    let targetCommit: string | undefined

    // Check lock file first (for --frozen mode or to use locked commit)
    const lockedMember = lockFile?.members[name]
    if (frozen) {
      if (lockedMember === undefined) {
        return {
          name,
          status: 'error',
          message: 'Not in lock file (--frozen requires lock file)',
        } satisfies MemberSyncResult
      }
      targetRef = lockedMember.ref
      targetCommit = lockedMember.commit
    } else if (lockedMember !== undefined && lockedMember.pinned) {
      // Use pinned commit from lock
      targetRef = lockedMember.ref
      targetCommit = lockedMember.commit
    } else {
      // Use ref from source string, or determine default
      const sourceRef = getSourceRef(source)
      if (Option.isSome(sourceRef)) {
        targetRef = sourceRef.value
      } else {
        // Need to determine default branch
        if (bareExists) {
          const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
          targetRef = Option.getOrElse(defaultBranch, () => 'main')
        } else {
          const defaultBranch = yield* Git.getDefaultBranch({ url: cloneUrl })
          targetRef = Option.getOrElse(defaultBranch, () => 'main')
        }
      }
    }

    // Check if member symlink already exists and points to a valid worktree
    const currentLink = yield* fs
      .readLink(memberPathNormalized)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    const memberExists = currentLink !== null

    // In default mode (no --pull), if member exists, just read current state for lock
    if (memberExists && !pull && !frozen) {
      // Read current HEAD from the worktree
      const currentCommit = yield* Git.getCurrentCommit(memberPathNormalized).pipe(
        Effect.catchAll(() => Effect.succeed(undefined)),
      )
      const currentBranchOpt = yield* Git.getCurrentBranch(memberPathNormalized).pipe(
        Effect.catchAll(() => Effect.succeed(Option.none<string>())),
      )
      const currentBranch = Option.getOrUndefined(currentBranchOpt)

      // Determine if lock needs updating
      const previousCommit = lockedMember?.commit
      const lockUpdated = currentCommit !== undefined && currentCommit !== previousCommit

      return {
        name,
        status: lockUpdated ? 'locked' : 'already_synced',
        commit: currentCommit,
        previousCommit: lockUpdated ? previousCommit : undefined,
        ref: currentBranch ?? lockedMember?.ref ?? targetRef,
        lockUpdated,
      } satisfies MemberSyncResult
    }

    // For --pull mode, check if worktree is dirty before making changes
    if (pull && memberExists && !frozen && !dryRun) {
      const worktreeStatus = yield* Git.getWorktreeStatus(currentLink).pipe(
        Effect.catchAll(() => Effect.succeed({ isDirty: false, hasUnpushed: false, changesCount: 0 })),
      )
      if ((worktreeStatus.isDirty || worktreeStatus.hasUnpushed) && !force) {
        return {
          name,
          status: 'skipped',
          message: worktreeStatus.isDirty
            ? `${worktreeStatus.changesCount} uncommitted changes (use --force to override)`
            : 'has unpushed commits (use --force to override)',
        } satisfies MemberSyncResult
      }
    }

    // Clone bare repo if needed
    let wasCloned = false
    if (!bareExists) {
      if (frozen) {
        return {
          name,
          status: 'error',
          message: 'Bare repo not in store (--frozen prevents cloning)',
        } satisfies MemberSyncResult
      }
      if (!dryRun) {
        const repoBasePath = store.getRepoBasePath(source)
        yield* fs.makeDirectory(repoBasePath, { recursive: true })
        yield* Git.cloneBare({ url: cloneUrl, targetPath: bareRepoPath })
        wasCloned = true
      }
    } else if (pull && !frozen && !dryRun) {
      // Only fetch when --pull is specified (not in default mode)
      yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(
        Effect.catchAll(() => Effect.void), // Ignore fetch errors
      )
    }

    // Resolve ref to commit if not already known
    if (targetCommit === undefined && !dryRun) {
      const refType = classifyRef(targetRef)
      if (refType === 'commit') {
        targetCommit = targetRef
      } else if (refType === 'tag') {
        targetCommit = yield* Git.resolveRef({
          repoPath: bareRepoPath,
          ref: `refs/tags/${targetRef}`,
        }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
      } else {
        // Branch - resolve to HEAD of branch
        targetCommit = yield* Git.resolveRef({
          repoPath: bareRepoPath,
          ref: `refs/remotes/origin/${targetRef}`,
        }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))
      }
    }

    // Create or update worktree
    // For frozen/pinned mode, use commit-based worktree path to guarantee exact reproducibility
    // This ensures the worktree is at exactly the locked commit, not whatever a branch points to
    const useCommitBasedPath = (frozen || lockedMember?.pinned) && targetCommit !== undefined
    // TypeScript note: when useCommitBasedPath is true, targetCommit is guaranteed to be defined
    const worktreeRef: string = useCommitBasedPath ? targetCommit! : targetRef
    const worktreePath = store.getWorktreePath({ source, ref: worktreeRef })
    const worktreeExists = yield* store.hasWorktree({ source, ref: worktreeRef })

    if (!worktreeExists && !dryRun) {
      // Ensure worktree parent directory exists
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create worktree
      // Use worktreeRef for classification - if commit-based path, always create detached
      const refType = classifyRef(worktreeRef)
      if (refType === 'commit' || refType === 'tag') {
        // Commit or tag: create detached worktree
        yield* Git.createWorktreeDetached({
          repoPath: bareRepoPath,
          worktreePath,
          commit: targetCommit ?? worktreeRef,
        })
      } else {
        // Branch worktree - can track the branch
        yield* Git.createWorktree({
          repoPath: bareRepoPath,
          worktreePath,
          branch: targetRef,
          createBranch: false,
        }).pipe(
          Effect.catchAll(() =>
            // If branch doesn't exist locally, create from remote
            Git.createWorktree({
              repoPath: bareRepoPath,
              worktreePath,
              branch: `origin/${targetRef}`,
              createBranch: false,
            }),
          ),
          Effect.catchAll(() =>
            // Last resort: create detached at the resolved commit
            Git.createWorktreeDetached({
              repoPath: bareRepoPath,
              worktreePath,
              commit: targetCommit ?? targetRef,
            }),
          ),
        )
      }
    }

    // Create symlink from workspace to worktree
    const existingLink = yield* fs
      .readLink(memberPathNormalized)
      .pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (existingLink !== null) {
      if (existingLink.replace(/\/$/, '') === worktreePath.replace(/\/$/, '')) {
        return {
          name,
          status: 'already_synced',
          commit: targetCommit,
          ref: targetRef,
        } satisfies MemberSyncResult
      }
      if (!dryRun) {
        yield* fs.remove(memberPathNormalized)
      }
    } else {
      const exists = yield* fs
        .exists(memberPathNormalized)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (exists) {
        return {
          name,
          status: 'skipped',
          message: 'Directory exists but is not a symlink',
        } satisfies MemberSyncResult
      }
    }

    if (!dryRun) {
      yield* createSymlink({ target: worktreePath, link: memberPathNormalized })
    }

    // Determine if this is a pull update (changed commit)
    const previousCommit = lockedMember?.commit
    const isUpdate = pull && previousCommit !== undefined && previousCommit !== targetCommit

    return {
      name,
      status: wasCloned ? 'cloned' : isUpdate ? 'updated' : 'synced',
      commit: targetCommit,
      previousCommit: isUpdate ? previousCommit : undefined,
      ref: targetRef,
      lockUpdated: true,
    } satisfies MemberSyncResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies MemberSyncResult),
    ),
  )

/** Result of syncing a megarepo (including nested) */
interface MegarepoSyncResult {
  readonly root: AbsoluteDirPath
  readonly results: ReadonlyArray<MemberSyncResult>
  readonly nestedMegarepos: ReadonlyArray<string>
  readonly nestedResults: ReadonlyArray<MegarepoSyncResult>
}

/** Flatten nested sync results for JSON output */
const flattenSyncResults = (result: MegarepoSyncResult): object => ({
  root: result.root,
  results: result.results,
  nestedMegarepos: result.nestedMegarepos,
  nestedResults: result.nestedResults.map(flattenSyncResults),
})

/** Count sync results including nested megarepos */
const countSyncResults = (
  r: MegarepoSyncResult,
): { synced: number; updated: number; locked: number; already: number; errors: number } => {
  const synced = r.results.filter((m) => m.status === 'cloned' || m.status === 'synced').length
  const updated = r.results.filter((m) => m.status === 'updated').length
  const locked = r.results.filter((m) => m.status === 'locked').length
  const already = r.results.filter((m) => m.status === 'already_synced').length
  const errors = r.results.filter((m) => m.status === 'error').length
  const nested = r.nestedResults.reduce(
    (acc, nr) => {
      const nc = countSyncResults(nr)
      return {
        synced: acc.synced + nc.synced,
        updated: acc.updated + nc.updated,
        locked: acc.locked + nc.locked,
        already: acc.already + nc.already,
        errors: acc.errors + nc.errors,
      }
    },
    { synced: 0, updated: 0, locked: 0, already: 0, errors: 0 },
  )
  return {
    synced: synced + nested.synced,
    updated: updated + nested.updated,
    locked: locked + nested.locked,
    already: already + nested.already,
    errors: errors + nested.errors,
  }
}

// =============================================================================
// Sync Errors
// =============================================================================

/** Error when not in a megarepo */
class NotInMegarepoError extends Schema.TaggedError<NotInMegarepoError>()('NotInMegarepoError', {
  message: Schema.String,
}) {}

/** Error when lock file is required but missing */
class LockFileRequiredError extends Schema.TaggedError<LockFileRequiredError>()(
  'LockFileRequiredError',
  {
    message: Schema.String,
  },
) {}

/** Error when lock file is stale */
class StaleLockFileError extends Schema.TaggedError<StaleLockFileError>()('StaleLockFileError', {
  message: Schema.String,
  addedMembers: Schema.Array(Schema.String),
  removedMembers: Schema.Array(Schema.String),
}) {}

/**
 * Sync a megarepo at the given root path.
 * This is extracted to enable recursive syncing for --deep mode.
 *
 * @param visited - Set of already-synced megarepo roots (resolved paths) to prevent duplicate syncing
 *                  in diamond dependency scenarios (e.g., A→B, A→C, B→D, C→D where D would be synced twice)
 * @param withProgress - When true, uses limited concurrency (4) for visible progress updates
 */
const syncMegarepo = ({
  megarepoRoot,
  options,
  depth = 0,
  visited = new Set<string>(),
  withProgress = false,
}: {
  megarepoRoot: AbsoluteDirPath
  options: { json: boolean; dryRun: boolean; pull: boolean; frozen: boolean; force: boolean; deep: boolean }
  depth?: number
  visited?: Set<string>
  withProgress?: boolean
}): Effect.Effect<
  MegarepoSyncResult,
  | NotInMegarepoError
  | LockFileRequiredError
  | StaleLockFileError
  | PlatformError.PlatformError
  | ParseResult.ParseError,
  FileSystem.FileSystem | CommandExecutor.CommandExecutor | Store | SyncProgressService
> =>
  Effect.gen(function* () {
    const { json, dryRun, pull, frozen, force, deep } = options
    const fs = yield* FileSystem.FileSystem
    const indent = '  '.repeat(depth)

    // Resolve to physical path for deduplication (handles symlinks)
    const resolvedRoot = yield* fs.realPath(megarepoRoot)

    // Check if we've already synced this megarepo (circuit breaker for diamond dependencies)
    if (visited.has(resolvedRoot)) {
      // Skip silently - duplicate syncing detected
      return {
        root: megarepoRoot,
        results: [],
        nestedMegarepos: [],
        nestedResults: [],
      } satisfies MegarepoSyncResult
    }

    // Mark as visited
    visited.add(resolvedRoot)

    // Load config
    const configPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    if (!dryRun) {
      const membersRoot = getMembersRoot(megarepoRoot)
      yield* fs.makeDirectory(membersRoot, { recursive: true })
    }

    // Load lock file (optional unless --frozen)
    const lockPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
    )
    const lockFileOpt = yield* readLockFile(lockPath)
    let lockFile = Option.getOrUndefined(lockFileOpt)

    // Determine which members are remote (need lock tracking)
    const remoteMemberNames = new Set<string>()
    for (const [name, sourceString] of Object.entries(config.members)) {
      const source = parseSourceString(sourceString)
      if (source !== undefined && isRemoteSource(source)) {
        remoteMemberNames.add(name)
      }
    }

    // Check --frozen requirements
    if (frozen) {
      if (lockFile === undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'no_lock',
              message: 'Lock file required for --frozen',
              root: megarepoRoot,
            }),
          )
        } else {
          yield* Console.error(
            `${indent}${styled.red(symbols.cross)} Lock file required for --frozen mode`,
          )
        }
        return yield* new LockFileRequiredError({ message: 'Lock file required for --frozen' })
      }

      // Check for staleness
      const staleness = checkLockStaleness({ lockFile, configMemberNames: remoteMemberNames })
      if (staleness.isStale) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'stale_lock',
              message: 'Lock file is stale',
              root: megarepoRoot,
              added: staleness.addedMembers,
              removed: staleness.removedMembers,
            }),
          )
        } else {
          yield* Console.error(`${indent}${styled.red(symbols.cross)} Lock file is stale`)
          if (staleness.addedMembers.length > 0) {
            yield* Console.log(styled.dim(`${indent}  Added: ${staleness.addedMembers.join(', ')}`))
          }
          if (staleness.removedMembers.length > 0) {
            yield* Console.log(
              styled.dim(`${indent}  Removed: ${staleness.removedMembers.join(', ')}`),
            )
          }
        }
        return yield* new StaleLockFileError({
          message: 'Lock file is stale',
          addedMembers: staleness.addedMembers,
          removedMembers: staleness.removedMembers,
        })
      }
    }

    const members = Object.entries(config.members)

    // Sync all members with limited concurrency for visible progress
    // Use unbounded for non-TTY (faster) or limited (4) for TTY (visible progress)
    const concurrency = withProgress ? 4 : 'unbounded'

    const results = yield* Effect.all(
      members.map(([name, sourceString]) =>
        Effect.gen(function* () {
          // Mark as syncing in progress service
          if (withProgress) {
            yield* setMemberSyncing(name).pipe(Effect.catchAll(() => Effect.void))
          }

          // Perform the sync
          const result = yield* syncMember({
            name,
            sourceString,
            megarepoRoot,
            lockFile,
            dryRun,
            pull,
            frozen,
            force,
          })

          // Apply result to progress service
          if (withProgress) {
            yield* applySyncResult(result).pipe(Effect.catchAll(() => Effect.void))
          }

          return result
        }),
      ),
      { concurrency },
    )

    // Check which members are themselves megarepos (for --deep)
    const nestedMegarepoChecks = yield* Effect.all(
      results.map((result) =>
        Effect.gen(function* () {
          if (result.status === 'error' || result.status === 'skipped') {
            return null
          }
          const memberPath = getMemberPath({ megarepoRoot, name: result.name })
          const nestedConfigPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const hasNestedConfig = yield* fs
            .exists(nestedConfigPath)
            .pipe(Effect.catchAll(() => Effect.succeed(false)))
          return hasNestedConfig ? result.name : null
        }),
      ),
      { concurrency: 'unbounded' },
    )
    const nestedMegarepos = nestedMegarepoChecks.filter((name): name is string => name !== null)

    // Update lock file (unless dry run or frozen)
    if (!dryRun && !frozen) {
      // Initialize lock file if needed
      if (lockFile === undefined) {
        lockFile = createEmptyLockFile()
      }

      // Sync lock with config (remove stale entries)
      lockFile = syncLockWithConfig({ lockFile, configMemberNames: remoteMemberNames })

      // Update lock entries from results
      for (const result of results) {
        // Only process results that have commit and ref info
        const commit = 'commit' in result ? result.commit : undefined
        const ref = 'ref' in result ? result.ref : undefined
        if (commit === undefined || ref === undefined) continue

        const sourceString = config.members[result.name]
        if (sourceString === undefined) continue
        const source = parseSourceString(sourceString)
        if (source === undefined || !isRemoteSource(source)) continue

        const url = getSourceUrl(source) ?? sourceString
        const existingLocked = lockFile.members[result.name]

        lockFile = upsertLockedMember({
          lockFile,
          memberName: result.name,
          update: {
            url,
            ref,
            commit,
            pinned: existingLocked?.pinned ?? false,
          },
        })
      }

      // Write lock file
      yield* writeLockFile({ lockPath, lockFile })
    }

    // Handle --deep flag: recursively sync nested megarepos
    const nestedResults: MegarepoSyncResult[] = []
    if (deep && nestedMegarepos.length > 0) {
      for (const nestedName of nestedMegarepos) {
        const nestedPath = getMemberPath({ megarepoRoot, name: nestedName })
        // Convert to AbsoluteDirPath (add trailing slash if needed)
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          nestedPath.endsWith('/') ? nestedPath : `${nestedPath}/`,
        )

        const nestedResult = yield* syncMegarepo({
          megarepoRoot: nestedRoot,
          options,
          depth: depth + 1,
          visited, // Pass visited set to prevent duplicate syncing
        }).pipe(
          Effect.catchAll(() =>
            // Return an empty result on error (errors are already in results)
            Effect.succeed({
              root: nestedRoot,
              results: [],
              nestedMegarepos: [],
              nestedResults: [],
            } satisfies MegarepoSyncResult),
          ),
        )

        nestedResults.push(nestedResult)
      }
    }

    return {
      root: megarepoRoot,
      results,
      nestedMegarepos,
      nestedResults,
    } satisfies MegarepoSyncResult
  })

/** Sync members: clone to store and create symlinks */
const syncCommand = Cli.Command.make(
  'sync',
  {
    json: jsonOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    pull: Cli.Options.boolean('pull').pipe(
      Cli.Options.withDescription('Fetch and update unpinned members to latest remote commits'),
      Cli.Options.withDefault(false),
    ),
    frozen: Cli.Options.boolean('frozen').pipe(
      Cli.Options.withDescription(
        'Use exact commits from lock file (fail if lock missing or stale)',
      ),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Force sync even with dirty worktrees or pinned members'),
      Cli.Options.withDefault(false),
    ),
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively sync nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, dryRun, pull, frozen, force, deep }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const fs = yield* FileSystem.FileSystem
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* new NotInMegarepoError({ message: 'No megarepo.json found' })
      }

      // Get workspace name
      const name = yield* Git.deriveMegarepoName(root.value)

      // Determine if we should use live progress (TTY and not JSON mode)
      const useLiveProgress = !json && isTTY()

      if (useLiveProgress) {
        // Load config to get member names for progress display
        const configPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
        )
        const configContent = yield* fs.readFileString(configPath)
        const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)
        const memberNames = Object.keys(config.members)

        // Start live progress UI
        const ui = yield* startSyncProgressUI({
          workspaceName: name,
          workspaceRoot: root.value,
          memberNames,
          dryRun,
          frozen,
          pull,
          deep,
        })

        // Run the sync with progress updates
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: { json, dryRun, pull, frozen, force, deep },
          withProgress: true,
        })

        // Mark complete and finish UI
        yield* completeSyncProgress()
        yield* finishSyncProgressUI(ui)

        // Return result (already displayed via UI)
        return syncResult
      } else {
        // Non-TTY or JSON mode: use original batch rendering
        const syncResult = yield* syncMegarepo({
          megarepoRoot: root.value,
          options: { json, dryRun, pull, frozen, force, deep },
        })

        // Output results
        if (json) {
          console.log(JSON.stringify(flattenSyncResults(syncResult)))
        } else {
          // Render using the batch renderer (for non-TTY)
          const lines = renderSync({
            name,
            root: root.value,
            results: syncResult.results,
            nestedMegarepos: syncResult.nestedMegarepos,
            deep,
            dryRun,
            frozen,
            pull,
          })
          yield* outputLines(lines)
        }

        return syncResult
      }
    }).pipe(Effect.provide(Layer.merge(StoreLayer, SyncProgressEmpty)), Effect.withSpan('megarepo/sync')),
).pipe(
  Cli.Command.withDescription(
    'Ensure members exist and update lock file to current worktree commits. Use --pull to fetch from remote.',
  ),
)

// =============================================================================
// Add Command
// =============================================================================

/**
 * Parse a repo reference and extract a suggested name.
 * Returns the source string as-is along with a suggested name.
 * Supports:
 * - GitHub shorthand: "owner/repo" or "owner/repo#ref"
 * - SSH URL: "git@github.com:owner/repo.git"
 * - HTTPS URL: "https://github.com/owner/repo.git"
 * - Local path: "/path/to/repo" or "./relative/path"
 */
const parseRepoRef = (ref: string): { sourceString: string; suggestedName: string } | undefined => {
  // Validate by parsing the source string
  const source = parseSourceString(ref)
  if (source === undefined) {
    return undefined
  }

  // Extract suggested name based on source type
  let suggestedName: string
  switch (source.type) {
    case 'github':
      suggestedName = source.repo
      break
    case 'url': {
      const parsed = Git.parseGitRemoteUrl(source.url)
      suggestedName = Option.isSome(parsed) ? parsed.value.repo : 'unknown'
      break
    }
    case 'path':
      suggestedName = source.path.split('/').findLast(Boolean) ?? 'unknown'
      break
  }

  return { sourceString: ref, suggestedName }
}

/** Add a member to megarepo.json */
const addCommand = Cli.Command.make(
  'add',
  {
    repo: Cli.Args.text({ name: 'repo' }).pipe(
      Cli.Args.withDescription('Repository reference (github shorthand, URL, or path)'),
    ),
    name: Cli.Options.text('name').pipe(
      Cli.Options.withAlias('n'),
      Cli.Options.withDescription('Override the member name (defaults to repo name)'),
      Cli.Options.optional,
    ),
    sync: Cli.Options.boolean('sync').pipe(
      Cli.Options.withAlias('s'),
      Cli.Options.withDescription('Sync the added repo immediately'),
      Cli.Options.withDefault(false),
    ),
    json: jsonOption,
  },
  ({ repo, name, sync, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Parse the repo reference
      const parsed = parseRepoRef(repo)
      if (parsed === undefined) {
        if (json) {
          console.log(
            JSON.stringify({ error: 'invalid_repo', message: `Invalid repo reference: ${repo}` }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Invalid repo reference: ${repo}`)
          yield* Console.log(
            styled.dim(
              '  Expected: owner/repo, git@host:owner/repo.git, https://host/owner/repo.git, or /path/to/repo',
            ),
          )
        }
        return yield* Effect.fail(new Error('Invalid repo reference'))
      }

      const memberName = Option.getOrElse(name, () => parsed.suggestedName)

      // Load current config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Check if member already exists
      if (memberName in config.members) {
        if (json) {
          console.log(JSON.stringify({ error: 'already_exists', member: memberName }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${memberName}' already exists`)
        }
        return yield* Effect.fail(new Error('Member already exists'))
      }

      // Add the new member
      const newConfig = {
        ...config,
        members: {
          ...config.members,
          [memberName]: parsed.sourceString,
        },
      }

      // Write updated config
      const newConfigContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
        newConfig,
      )
      yield* fs.writeFileString(configPath, newConfigContent + '\n')

      if (json) {
        console.log(
          JSON.stringify({ status: 'added', member: memberName, source: parsed.sourceString }),
        )
      } else {
        yield* Console.log(`${styled.green(symbols.check)} Added ${styled.bold(memberName)}`)
      }

      // Sync if requested
      if (sync) {
        if (!json) {
          yield* Console.log(styled.dim('Syncing...'))
        }
        const result = yield* syncMember({
          name: memberName,
          sourceString: parsed.sourceString,
          megarepoRoot: root.value,
          lockFile: undefined,
          dryRun: false,
          pull: true, // Fetch when adding
          frozen: false,
          force: false,
        })
        if (!json) {
          const statusSymbol =
            result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
          const statusText = result.status === 'cloned' ? 'cloned' : result.status
          yield* Console.log(
            `${statusSymbol} ${styled.bold(memberName)} ${styled.dim(`(${statusText})`)}`,
          )
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/add')),
).pipe(Cli.Command.withDescription('Add a new member repository'))

// =============================================================================
// Update Command
// =============================================================================

/** Member update result */
interface MemberUpdateResult {
  readonly name: string
  readonly status: 'updated' | 'skipped' | 'pinned' | 'error'
  readonly message?: string | undefined
  readonly oldCommit?: string | undefined
  readonly newCommit?: string | undefined
}

/**
 * Update a single member: fetch latest, update worktree, update lock file.
 * Respects pinned status unless force is true.
 */
const updateMember = ({
  name,
  sourceString,
  _megarepoRoot,
  lockFile,
  force,
}: {
  name: string
  sourceString: string
  _megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  force: boolean
}) =>
  Effect.gen(function* () {
    const _fs = yield* FileSystem.FileSystem
    const store = yield* Store

    // Parse source string
    const source = parseSourceString(sourceString)
    if (source === undefined) {
      return {
        name,
        status: 'error',
        message: `Invalid source string: ${sourceString}`,
      } satisfies MemberUpdateResult
    }

    // Skip local path sources - they don't need updating
    if (source.type === 'path') {
      return {
        name,
        status: 'skipped',
        message: 'Local path (nothing to update)',
      } satisfies MemberUpdateResult
    }

    // Check if member is pinned (skip unless force)
    const lockedMember = lockFile?.members[name]
    if (lockedMember?.pinned && !force) {
      return {
        name,
        status: 'pinned',
        message: `Pinned at ${lockedMember.commit.slice(0, 7)}`,
        oldCommit: lockedMember.commit,
        newCommit: lockedMember.commit,
      } satisfies MemberUpdateResult
    }

    // Check if bare repo exists
    const bareRepoPath = store.getBareRepoPath(source)
    const bareExists = yield* store.hasBareRepo(source)

    if (!bareExists) {
      return {
        name,
        status: 'skipped',
        message: 'Not synced yet (no bare repo)',
      } satisfies MemberUpdateResult
    }

    // Determine the ref to update
    const sourceRef = getSourceRef(source)
    let targetRef: string
    if (Option.isSome(sourceRef)) {
      targetRef = sourceRef.value
    } else if (lockedMember !== undefined) {
      targetRef = lockedMember.ref
    } else {
      // Need to determine default branch
      const defaultBranch = yield* Git.getDefaultBranch({ repoPath: bareRepoPath })
      targetRef = Option.getOrElse(defaultBranch, () => 'main')
    }

    // For commits and tags, nothing to update
    const refType = classifyRef(targetRef)
    if (refType === 'commit' || refType === 'tag') {
      return {
        name,
        status: 'skipped',
        message: refType === 'commit' ? 'Pinned to specific commit' : 'Pinned to tag',
        oldCommit: lockedMember?.commit,
        newCommit: lockedMember?.commit,
      } satisfies MemberUpdateResult
    }

    // Fetch latest from remote
    yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(Effect.catchAll(() => Effect.void))

    // Resolve branch to new commit
    const newCommit = yield* Git.resolveRef({
      repoPath: bareRepoPath,
      ref: `refs/remotes/origin/${targetRef}`,
    }).pipe(Effect.catchAll(() => Git.resolveRef({ repoPath: bareRepoPath, ref: targetRef })))

    const oldCommit = lockedMember?.commit

    // Check if there's anything to update
    if (oldCommit === newCommit) {
      return {
        name,
        status: 'skipped',
        message: 'Already up to date',
        oldCommit,
        newCommit,
      } satisfies MemberUpdateResult
    }

    // Update the worktree
    const worktreePath = store.getWorktreePath({ source, ref: targetRef })
    const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef })

    if (worktreeExists) {
      // Try to update the worktree
      yield* Git.checkoutWorktree({ worktreePath, ref: newCommit }).pipe(
        Effect.catchAll(() =>
          // If checkout fails, try a hard reset (detached worktrees)
          Effect.gen(function* () {
            const cmd = Command.make('git', 'reset', '--hard', newCommit).pipe(
              Command.workingDirectory(worktreePath),
            )
            yield* Command.string(cmd)
          }),
        ),
      )
    }

    return {
      name,
      status: 'updated',
      oldCommit,
      newCommit,
    } satisfies MemberUpdateResult
  }).pipe(
    Effect.catchAll((error) =>
      Effect.succeed({
        name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      } satisfies MemberUpdateResult),
    ),
  )

/** Update (pull) repos - fetch latest refs and update worktrees */
const updateCommand = Cli.Command.make(
  'update',
  {
    json: jsonOption,
    member: Cli.Options.text('member').pipe(
      Cli.Options.withAlias('m'),
      Cli.Options.withDescription('Update only this member'),
      Cli.Options.optional,
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Update even if pinned'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, member, force }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const fs = yield* FileSystem.FileSystem

      // Load config
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Load lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lockFile = Option.getOrUndefined(lockFileOpt)

      // Filter members if specific one requested
      const membersToUpdate = Option.match(member, {
        onNone: () => Object.entries(config.members),
        onSome: (m) => {
          const sourceString = config.members[m]
          return sourceString !== undefined ? [[m, sourceString] as const] : []
        },
      })

      if (membersToUpdate.length === 0) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const results: MemberUpdateResult[] = []

      for (const [name, sourceString] of membersToUpdate) {
        const result = yield* updateMember({
          name,
          sourceString,
          _megarepoRoot: root.value,
          lockFile,
          force,
        })
        results.push(result)

        if (!json) {
          const statusSymbol =
            result.status === 'error'
              ? styled.red(symbols.cross)
              : result.status === 'updated'
                ? styled.green(symbols.check)
                : result.status === 'pinned'
                  ? styled.yellow('⊘')
                  : styled.dim(symbols.check)

          let statusText: string
          if (result.status === 'updated' && result.oldCommit && result.newCommit) {
            statusText = `${result.oldCommit.slice(0, 7)} → ${result.newCommit.slice(0, 7)}`
          } else if (result.status === 'pinned') {
            statusText = `pinned${result.message ? ` (${result.message})` : ''}`
          } else if (result.message) {
            statusText = result.message
          } else {
            statusText = result.status
          }

          yield* Console.log(
            `${statusSymbol} ${styled.bold(name)} ${styled.dim(`(${statusText})`)}`,
          )
        }

        // Update lock file entry if we got a new commit
        if (
          result.status === 'updated' &&
          result.newCommit !== undefined &&
          lockFile !== undefined
        ) {
          const source = parseSourceString(sourceString)
          if (source !== undefined && isRemoteSource(source)) {
            const sourceRef = getSourceRef(source)
            const url = getSourceUrl(source) ?? sourceString
            const ref = Option.isSome(sourceRef)
              ? sourceRef.value
              : (lockFile.members[name]?.ref ?? 'main')
            const existingLocked = lockFile.members[name]

            lockFile = upsertLockedMember({
              lockFile,
              memberName: name,
              update: {
                url,
                ref,
                commit: result.newCommit,
                pinned: existingLocked?.pinned ?? false,
              },
            })
          }
        }
      }

      // Write updated lock file
      if (lockFile !== undefined) {
        yield* writeLockFile({ lockPath, lockFile })
      }

      if (json) {
        console.log(JSON.stringify({ results }))
      } else {
        const updatedCount = results.filter((r) => r.status === 'updated').length
        const skippedCount = results.filter((r) => r.status === 'skipped').length
        const pinnedCount = results.filter((r) => r.status === 'pinned').length
        const errorCount = results.filter((r) => r.status === 'error').length

        yield* Console.log('')
        const parts: string[] = []
        if (updatedCount > 0) parts.push(`${updatedCount} updated`)
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`)
        if (pinnedCount > 0) parts.push(`${pinnedCount} pinned`)
        yield* Console.log(styled.dim(parts.join(', ')))

        if (errorCount > 0) {
          yield* Console.log(styled.red(`${errorCount} error(s)`))
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/update')),
).pipe(Cli.Command.withDescription('Update members to latest remote refs'))

// =============================================================================
// Exec Command
// =============================================================================

/** Execute command across members */
const execCommand = Cli.Command.make(
  'exec',
  {
    command: Cli.Args.text({ name: 'command' }).pipe(
      Cli.Args.withDescription('Command to execute'),
    ),
    json: jsonOption,
    member: Cli.Options.text('member').pipe(
      Cli.Options.withAlias('m'),
      Cli.Options.withDescription('Run only in this member'),
      Cli.Options.optional,
    ),
  },
  ({ command: cmd, json, member }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      // Filter members
      const membersToRun = Option.match(member, {
        onNone: () => Object.keys(config.members),
        onSome: (m) => (m in config.members ? [m] : []),
      })

      if (membersToRun.length === 0) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const results: Array<{ name: string; exitCode: number; stdout: string; stderr: string }> = []

      for (const name of membersToRun) {
        const memberPath = getMemberPath({ megarepoRoot: root.value, name })
        const exists = yield* fs.exists(memberPath)

        if (!exists) {
          results.push({ name, exitCode: -1, stdout: '', stderr: 'Member not synced' })
          continue
        }

        if (!json) {
          yield* Console.log(styled.bold(`\n${name}:`))
        }

        // Run the command
        const result = yield* Effect.gen(function* () {
          const shellCmd = Command.make('sh', '-c', cmd).pipe(Command.workingDirectory(memberPath))
          const output = yield* Command.string(shellCmd)
          return { name, exitCode: 0, stdout: output, stderr: '' }
        }).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              name,
              exitCode: 1,
              stdout: '',
              stderr: error instanceof Error ? error.message : String(error),
            }),
          ),
        )

        results.push(result)

        if (!json) {
          if (result.stdout) {
            console.log(result.stdout)
          }
          if (result.stderr) {
            console.error(styled.red(result.stderr))
          }
        }
      }

      if (json) {
        console.log(JSON.stringify({ results }))
      }
    }).pipe(Effect.withSpan('megarepo/exec')),
).pipe(Cli.Command.withDescription('Execute a command in member directories'))

// =============================================================================
// Pin / Unpin Commands
// =============================================================================

/**
 * Pin a member to its current commit.
 * Pinned members won't be updated by `mr update` unless explicitly named.
 */
const pinCommand = Cli.Command.make(
  'pin',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to pin')),
    json: jsonOption,
  },
  ({ member, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const fs = yield* FileSystem.FileSystem

      // Load config to verify member exists
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      if (!(member in config.members)) {
        if (json) {
          console.log(
            JSON.stringify({ error: 'not_found', message: `Member '${member}' not found` }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${member}' not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      // Check if it's a local path (can't pin local paths)
      const sourceString = config.members[member]
      if (sourceString === undefined) {
        return yield* Effect.fail(new Error('Member not found'))
      }
      const source = parseSourceString(sourceString)
      if (source === undefined) {
        if (json) {
          console.log(JSON.stringify({ error: 'invalid_source', message: 'Invalid source string' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Invalid source string`)
        }
        return yield* Effect.fail(new Error('Invalid source'))
      }
      if (!isRemoteSource(source)) {
        if (json) {
          console.log(
            JSON.stringify({ error: 'local_path', message: 'Cannot pin local path members' }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Cannot pin local path members`)
        }
        return yield* Effect.fail(new Error('Cannot pin local path'))
      }

      // Load or create lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      let lockFile = Option.getOrElse(lockFileOpt, () => createEmptyLockFile())

      // Check if member is in lock file
      const lockedMember = Option.getOrUndefined(getLockedMember({ lockFile, memberName: member }))
      if (lockedMember === undefined) {
        if (json) {
          console.log(
            JSON.stringify({
              error: 'not_synced',
              message: 'Member not synced yet. Run mr sync first.',
            }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${member}' not synced yet.`)
          yield* Console.log(styled.dim('  Run: mr sync'))
        }
        return yield* Effect.fail(new Error('Member not synced'))
      }

      // Check if already pinned
      if (lockedMember.pinned) {
        if (json) {
          console.log(
            JSON.stringify({ status: 'already_pinned', member, commit: lockedMember.commit }),
          )
        } else {
          yield* Console.log(
            styled.dim(
              `Member '${member}' is already pinned at ${lockedMember.commit.slice(0, 7)}`,
            ),
          )
        }
        return
      }

      // Pin the member
      lockFile = pinMember({ lockFile, memberName: member })
      yield* writeLockFile({ lockPath, lockFile })

      if (json) {
        console.log(JSON.stringify({ status: 'pinned', member, commit: lockedMember.commit }))
      } else {
        yield* Console.log(
          `${styled.green(symbols.check)} Pinned ${styled.bold(member)} at ${styled.dim(lockedMember.commit.slice(0, 7))}`,
        )
      }
    }).pipe(Effect.withSpan('megarepo/pin')),
).pipe(Cli.Command.withDescription('Pin a member to its current commit'))

/**
 * Unpin a member, allowing it to be updated by `mr update`.
 */
const unpinCommand = Cli.Command.make(
  'unpin',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to unpin')),
    json: jsonOption,
  },
  ({ member, json }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const fs = yield* FileSystem.FileSystem

      // Load config to verify member exists
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      if (!(member in config.members)) {
        if (json) {
          console.log(
            JSON.stringify({ error: 'not_found', message: `Member '${member}' not found` }),
          )
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Member '${member}' not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      // Load lock file
      const lockPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
      )
      const lockFileOpt = yield* readLockFile(lockPath)
      if (Option.isNone(lockFileOpt)) {
        if (json) {
          console.log(JSON.stringify({ error: 'no_lock', message: 'No lock file found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} No lock file found`)
        }
        return yield* Effect.fail(new Error('No lock file'))
      }
      let lockFile = lockFileOpt.value

      // Check if member is in lock file
      const lockedMember = Option.getOrUndefined(getLockedMember({ lockFile, memberName: member }))
      if (lockedMember === undefined) {
        if (json) {
          console.log(JSON.stringify({ status: 'not_in_lock', member }))
        } else {
          yield* Console.log(styled.dim(`Member '${member}' not in lock file`))
        }
        return
      }

      // Check if already unpinned
      if (!lockedMember.pinned) {
        if (json) {
          console.log(JSON.stringify({ status: 'already_unpinned', member }))
        } else {
          yield* Console.log(styled.dim(`Member '${member}' is not pinned`))
        }
        return
      }

      // Unpin the member
      lockFile = unpinMember({ lockFile, memberName: member })
      yield* writeLockFile({ lockPath, lockFile })

      if (json) {
        console.log(JSON.stringify({ status: 'unpinned', member }))
      } else {
        yield* Console.log(`${styled.green(symbols.check)} Unpinned ${styled.bold(member)}`)
      }
    }).pipe(Effect.withSpan('megarepo/unpin')),
).pipe(Cli.Command.withDescription('Unpin a member to allow updates'))

// =============================================================================
// Store Commands
// =============================================================================

/** List repos in the store */
const storeLsCommand = Cli.Command.make('ls', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()

    if (json) {
      console.log(JSON.stringify({ repos }))
    } else {
      yield* Console.log(styled.bold('store'))
      yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
      yield* Console.log('')

      if (repos.length === 0) {
        yield* Console.log(styled.dim('(empty)'))
      } else {
        yield* Console.log(separator())
        yield* Console.log('')
        for (const repo of repos) {
          yield* Console.log(`${styled.green(symbols.check)} ${repo.relativePath}`)
        }
        yield* Console.log('')
        yield* Console.log(styled.dim(`${repos.length} repositories`))
      }
    }
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/ls'), withJsonMode(json)),
).pipe(Cli.Command.withDescription('List repositories in the store'))

/** Fetch all repos in the store */
const storeFetchCommand = Cli.Command.make('fetch', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()
    const startTime = Date.now()

    // For TTY: use live progress rendering
    // For non-TTY (piped): just collect results silently
    const useLiveProgress = !json && isTTY()

    // Create progress state
    const progressState = createProgressListState(
      repos.map((repo) => ({ id: repo.relativePath, label: repo.relativePath })),
    )

    if (useLiveProgress) {
      // Print header
      yield* Console.log(styled.bold('store'))
      yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
      yield* Console.log('')
      yield* Console.log(separator())
      yield* Console.log('')

      // Start progress display
      startProgressList(progressState)
      startSpinner(progressState, 80)
    }

    // Fetch repos with limited concurrency for visible progress
    const results = yield* Effect.all(
      repos.map((repo) =>
        Effect.gen(function* () {
          // Mark as active
          if (useLiveProgress) {
            markActive(progressState, repo.relativePath, 'fetching...')
            updateProgressList(progressState)
          }

          // The bare repo is in the .bare/ subdirectory
          const bareRepoPath = EffectPath.ops.join(
            repo.fullPath,
            EffectPath.unsafe.relativeDir('.bare/'),
          )

          const result = yield* Git.fetchBare({ repoPath: bareRepoPath }).pipe(
            Effect.map(() => {
              if (useLiveProgress) {
                markSuccess(progressState, repo.relativePath)
                updateProgressList(progressState)
              }
              return { path: repo.relativePath, status: 'fetched' as const }
            }),
            Effect.catchAll((error) => {
              const message = error instanceof Error ? error.message : String(error)
              if (useLiveProgress) {
                markError(progressState, repo.relativePath, message)
                updateProgressList(progressState)
              }
              return Effect.succeed({
                path: repo.relativePath,
                status: 'error' as const,
                message,
              })
            }),
          )

          return result
        }),
      ),
      { concurrency: 4 },
    )

    const elapsed = Date.now() - startTime

    if (useLiveProgress) {
      // Finish progress display
      finishProgressList(progressState)

      // Print summary
      const fetchedCount = results.filter((r) => r.status === 'fetched').length
      const errorCount = results.filter((r) => r.status === 'error').length
      const parts: string[] = [`${fetchedCount} fetched`]
      if (errorCount > 0) {
        parts.push(styled.red(`${errorCount} error${errorCount > 1 ? 's' : ''}`))
      }
      parts.push(formatElapsed(elapsed))
      yield* Console.log(styled.dim(parts.join(' · ')))
    } else if (json) {
      console.log(JSON.stringify({ results }))
    } else {
      // Non-TTY: print final results only
      yield* Console.log(styled.bold('store'))
      yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
      yield* Console.log('')
      yield* Console.log(separator())
      yield* Console.log('')

      for (const result of results) {
        const symbol =
          result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
        const suffix =
          result.status === 'error' && result.message
            ? styled.dim(` (${result.message})`)
            : ''
        yield* Console.log(`${symbol} ${result.path}${suffix}`)
      }

      yield* Console.log('')
      const fetchedCount = results.filter((r) => r.status === 'fetched').length
      const errorCount = results.filter((r) => r.status === 'error').length
      const parts: string[] = [`${fetchedCount} fetched`]
      if (errorCount > 0) {
        parts.push(styled.red(`${errorCount} error${errorCount > 1 ? 's' : ''}`))
      }
      parts.push(formatElapsed(elapsed))
      yield* Console.log(styled.dim(parts.join(' · ')))
    }
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/fetch')),
).pipe(Cli.Command.withDescription('Fetch all repositories in the store'))

/** GC result for a single worktree */
interface GcWorktreeResult {
  readonly repo: string
  readonly ref: string
  readonly path: string
  readonly status: 'removed' | 'skipped_dirty' | 'skipped_in_use' | 'error'
  readonly message?: string
}

/**
 * Garbage collect unused worktrees from the store.
 * Removes worktrees that are not referenced by any megarepo's lock file.
 */
const storeGcCommand = Cli.Command.make(
  'gc',
  {
    json: jsonOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be removed without removing'),
      Cli.Options.withDefault(false),
    ),
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Remove dirty worktrees (with uncommitted changes)'),
      Cli.Options.withDefault(false),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Remove all worktrees (not just unused ones)'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, dryRun, force, all }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const store = yield* Store
      const fs = yield* FileSystem.FileSystem

      // Get lock file from current megarepo (if any)
      const root = yield* findMegarepoRoot(cwd)
      let lockFile: LockFile | undefined
      let inUsePaths = new Set<string>()

      if (Option.isSome(root) && !all) {
        const lockPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
        )
        const lockFileOpt = yield* readLockFile(lockPath)
        lockFile = Option.getOrUndefined(lockFileOpt)

        // Build set of worktree paths that are "in use"
        if (lockFile !== undefined) {
          const configPath = EffectPath.ops.join(
            root.value,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const configContent = yield* fs.readFileString(configPath)
          const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
            configContent,
          )

          for (const [name, sourceString] of Object.entries(config.members)) {
            const source = parseSourceString(sourceString)
            if (source === undefined || !isRemoteSource(source)) continue

            const lockedMember = lockFile.members[name]
            if (lockedMember === undefined) continue

            // Mark the worktree path as in use
            const worktreePath = store.getWorktreePath({ source, ref: lockedMember.ref })
            inUsePaths.add(worktreePath)
          }
        }
      }

      if (!json && !all && Option.isNone(root)) {
        yield* Console.log(
          styled.dim('Not in a megarepo - all worktrees will be considered unused'),
        )
        yield* Console.log('')
      }

      // List all repos and their worktrees
      const repos = yield* store.listRepos()
      const results: GcWorktreeResult[] = []

      for (const repo of repos) {
        // List worktrees for this repo
        // We need to construct a mock source for listing
        const worktrees = yield* Effect.gen(function* () {
          const refsDir = EffectPath.ops.join(repo.fullPath, EffectPath.unsafe.relativeDir('refs/'))
          const exists = yield* fs.exists(refsDir)
          if (!exists) return []

          const result: Array<{
            ref: string
            refType: string
            path: AbsoluteDirPath
          }> = []

          const refTypes = yield* fs.readDirectory(refsDir)
          for (const refTypeDir of refTypes) {
            if (refTypeDir !== 'heads' && refTypeDir !== 'tags' && refTypeDir !== 'commits')
              continue

            const refTypePath = EffectPath.ops.join(
              refsDir,
              EffectPath.unsafe.relativeDir(`${refTypeDir}/`),
            )
            const refTypeStat = yield* fs
              .stat(refTypePath)
              .pipe(Effect.catchAll(() => Effect.succeed(null)))
            if (refTypeStat?.type !== 'Directory') continue

            const encodedRefs = yield* fs.readDirectory(refTypePath)
            for (const encodedRef of encodedRefs) {
              const worktreePath = EffectPath.ops.join(
                refTypePath,
                EffectPath.unsafe.relativeDir(`${encodedRef}/`),
              )
              const worktreeStat = yield* fs
                .stat(worktreePath)
                .pipe(Effect.catchAll(() => Effect.succeed(null)))
              if (worktreeStat?.type !== 'Directory') continue

              const ref = decodeURIComponent(encodedRef)
              result.push({ ref, refType: refTypeDir, path: worktreePath })
            }
          }

          return result
        })

        for (const worktree of worktrees) {
          // Check if worktree is in use
          if (inUsePaths.has(worktree.path)) {
            results.push({
              repo: repo.relativePath,
              ref: worktree.ref,
              path: worktree.path,
              status: 'skipped_in_use',
            })
            continue
          }

          // Check if worktree is dirty
          const status = yield* Git.getWorktreeStatus(worktree.path).pipe(
            Effect.catchAll(() =>
              Effect.succeed({ isDirty: false, hasUnpushed: false, changesCount: 0 }),
            ),
          )

          if ((status.isDirty || status.hasUnpushed) && !force) {
            results.push({
              repo: repo.relativePath,
              ref: worktree.ref,
              path: worktree.path,
              status: 'skipped_dirty',
              message: status.isDirty
                ? `${status.changesCount} uncommitted change(s)`
                : 'has unpushed commits',
            })
            continue
          }

          // Remove the worktree
          if (!dryRun) {
            yield* Effect.gen(function* () {
              const bareRepoPath = EffectPath.ops.join(
                repo.fullPath,
                EffectPath.unsafe.relativeDir('.bare/'),
              )
              yield* Git.removeWorktree({
                repoPath: bareRepoPath,
                worktreePath: worktree.path,
                force: force,
              }).pipe(
                Effect.catchAll(() =>
                  // If git worktree remove fails, try removing the directory directly
                  fs.remove(worktree.path, { recursive: true }),
                ),
              )
            }).pipe(
              Effect.catchAll((error) =>
                Effect.succeed({
                  error: error instanceof Error ? error.message : String(error),
                }),
              ),
            )
          }

          results.push({
            repo: repo.relativePath,
            ref: worktree.ref,
            path: worktree.path,
            status: 'removed',
          })
        }
      }

      // Output results
      if (json) {
        console.log(
          JSON.stringify({
            dryRun,
            results,
            summary: {
              removed: results.filter((r) => r.status === 'removed').length,
              skippedDirty: results.filter((r) => r.status === 'skipped_dirty').length,
              skippedInUse: results.filter((r) => r.status === 'skipped_in_use').length,
              errors: results.filter((r) => r.status === 'error').length,
            },
          }),
        )
      } else {
        const removed = results.filter((r) => r.status === 'removed')
        const skippedDirty = results.filter((r) => r.status === 'skipped_dirty')
        const skippedInUse = results.filter((r) => r.status === 'skipped_in_use')

        // Header
        yield* Console.log(styled.bold('store gc'))
        yield* Console.log(kv('path', store.basePath, { keyStyle: (k) => styled.dim(`  ${k}`) }))
        if (dryRun) {
          yield* Console.log(styled.dim('  mode: dry run'))
        }
        yield* Console.log('')
        yield* Console.log(separator())
        yield* Console.log('')

        if (results.length === 0) {
          yield* Console.log(styled.dim('No worktrees found'))
        } else {
          // Removed worktrees
          for (const r of removed) {
            const verb = dryRun ? 'would remove' : 'removed'
            yield* Console.log(
              `${styled.green(symbols.check)} ${r.repo}refs/${r.ref} ${styled.dim(`(${verb})`)}`,
            )
          }

          // Skipped dirty worktrees
          for (const r of skippedDirty) {
            yield* Console.log(
              `${styled.yellow(symbols.circle)} ${r.repo}refs/${r.ref} ${styled.dim(`(${r.message})`)}`,
            )
          }

          // Skipped in-use worktrees (only show if few results)
          if (skippedInUse.length > 0 && skippedInUse.length <= 5) {
            for (const r of skippedInUse) {
              yield* Console.log(
                `${styled.dim(symbols.check)} ${styled.dim(`${r.repo}refs/${r.ref}`)} ${styled.dim('(in use)')}`,
              )
            }
          }
        }

        // Summary
        yield* Console.log('')
        const parts: string[] = []
        if (removed.length > 0) parts.push(`${removed.length} ${dryRun ? 'would be ' : ''}removed`)
        if (skippedDirty.length > 0) parts.push(`${skippedDirty.length} skipped (dirty)`)
        if (skippedInUse.length > 0) parts.push(`${skippedInUse.length} in use`)
        yield* Console.log(styled.dim(parts.length > 0 ? parts.join(' · ') : 'Nothing to clean up'))

        if (skippedDirty.length > 0 && !force) {
          yield* Console.log(styled.dim('Use --force to remove dirty worktrees'))
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/gc')),
).pipe(Cli.Command.withDescription('Garbage collect unused worktrees'))

/** Store subcommand group */
const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([storeLsCommand, storeFetchCommand, storeGcCommand]),
  Cli.Command.withDescription('Manage the shared git store'),
)

// =============================================================================
// Generate Command
// =============================================================================

/** Generate Nix workspace */
interface NixGenerateTree {
  readonly root: AbsoluteDirPath
  readonly result: {
    readonly workspaceRoot: AbsoluteDirPath
    readonly flakePath: AbsoluteFilePath
    readonly envrcPath: AbsoluteFilePath
  }
  readonly nested: readonly NixGenerateTree[]
}

const flattenNixGenerateTree = (
  tree: NixGenerateTree,
): Array<NixGenerateTree['result'] & { root: AbsoluteDirPath }> => [
  { root: tree.root, ...tree.result },
  ...tree.nested.flatMap(flattenNixGenerateTree),
]

const generateNixForRoot = Effect.fn('megarepo/generate/nix/root')(function* ({
  outermostRoot,
  currentRoot,
  deep,
  json,
  depth,
  visited,
}: {
  outermostRoot: AbsoluteDirPath
  currentRoot: AbsoluteDirPath
  deep: boolean
  json: boolean
  depth: number
  visited: Set<string>
}): Effect.Effect<Option.Option<NixGenerateTree>, NixGeneratorError> {
  const rootKey = currentRoot.replace(/\/$/, '')
  if (visited.has(rootKey)) {
    return Option.none()
  }
  visited.add(rootKey)

  const indent = '  '.repeat(depth)
  const fs = yield* FileSystem.FileSystem
  const configPath = EffectPath.ops.join(
    currentRoot,
    EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
  )
  const configContent = yield* fs.readFileString(configPath)
  const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

  if (!json && depth > 0) {
    yield* Console.log(`${indent}${styled.dim(`Generating ${currentRoot}...`)}`)
  }

  const result = yield* generateNix({
    megarepoRootOutermost: outermostRoot,
    megarepoRootNearest: currentRoot,
    config,
  })

  if (!json) {
    yield* Console.log(
      `${indent}${styled.green(symbols.check)} Generated ${styled.bold('.envrc.generated.megarepo')}`,
    )
    yield* Console.log(
      `${indent}${styled.green(symbols.check)} Generated ${styled.bold('.direnv/megarepo-nix/workspace')}`,
    )
  }

  const nested: NixGenerateTree[] = []
  if (deep) {
    const nestedRoots: AbsoluteDirPath[] = []
    for (const [name] of Object.entries(config.members)) {
      const memberPath = getMemberPath({ megarepoRoot: currentRoot, name })
      const nestedConfigPath = EffectPath.ops.join(
        memberPath,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const hasNestedConfig = yield* fs
        .exists(nestedConfigPath)
        .pipe(Effect.catchAll(() => Effect.succeed(false)))
      if (hasNestedConfig) {
        nestedRoots.push(
          EffectPath.unsafe.absoluteDir(memberPath.endsWith('/') ? memberPath : `${memberPath}/`),
        )
      }
    }

    if (nestedRoots.length > 0 && !json) {
      yield* Console.log('')
      yield* Console.log(`${indent}${styled.bold('Generating nested megarepos...')}`)
    }

    for (const nestedRoot of nestedRoots) {
      const nestedResult = yield* generateNixForRoot({
        outermostRoot,
        currentRoot: nestedRoot,
        deep,
        json,
        depth: depth + 1,
        visited,
      })
      if (Option.isSome(nestedResult)) {
        nested.push(nestedResult.value)
      }
    }
  }

  return Option.some({
    root: currentRoot,
    result,
    nested,
  })
})

const generateNixCommand = Cli.Command.make(
  'nix',
  {
    json: jsonOption,
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively generate nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, deep }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      const result = yield* generateNixForRoot({
        outermostRoot: root.value,
        currentRoot: root.value,
        deep,
        json,
        depth: 0,
        visited: new Set(),
      })

      if (Option.isNone(result)) return

      if (json) {
        console.log(
          JSON.stringify({
            status: 'generated',
            results: flattenNixGenerateTree(result.value),
          }),
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/nix')),
).pipe(Cli.Command.withDescription('Generate local Nix workspace'))

/** Generate VSCode workspace file */
const generateVscodeCommand = Cli.Command.make(
  'vscode',
  {
    json: jsonOption,
    exclude: Cli.Options.text('exclude').pipe(
      Cli.Options.withDescription('Comma-separated list of members to exclude'),
      Cli.Options.optional,
    ),
  },
  ({ json, exclude }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      const excludeList = Option.map(exclude, (e) => e.split(',').map((s) => s.trim()))

      const result = yield* generateVscode({
        megarepoRoot: root.value,
        config,
        ...(Option.isSome(excludeList) ? { exclude: excludeList.value } : {}),
      })

      if (json) {
        console.log(JSON.stringify({ status: 'generated', path: result.path }))
      } else {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/vscode')),
).pipe(Cli.Command.withDescription('Generate VS Code workspace file'))

/** Generate JSON Schema */
const generateSchemaCommand = Cli.Command.make(
  'schema',
  {
    json: jsonOption,
    output: Cli.Options.text('output').pipe(
      Cli.Options.withAlias('o'),
      Cli.Options.withDescription('Output path (relative to megarepo root)'),
      Cli.Options.withDefault('schema/megarepo.schema.json'),
    ),
  },
  ({ json, output }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
        }
        return yield* Effect.fail(new Error('Not in a megarepo'))
      }

      // Load config
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const configContent = yield* fs.readFileString(configPath)
      const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

      const result = yield* generateSchema({
        megarepoRoot: root.value,
        config,
        outputPath: output,
      })

      if (json) {
        console.log(JSON.stringify({ status: 'generated', path: result.path }))
      } else {
        yield* Console.log(`${styled.green(symbols.check)} Generated ${styled.bold(output)}`)
      }
    }).pipe(Effect.withSpan('megarepo/generate/schema')),
).pipe(Cli.Command.withDescription('Generate JSON schema for megarepo.json'))

/** Generate all configured outputs */
const generateAllCommand = Cli.Command.make('all', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Console.error(`${styled.red(symbols.cross)} Not in a megarepo`)
      }
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    // Load config
    const fs = yield* FileSystem.FileSystem
    const configPath = EffectPath.ops.join(
      root.value,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    const results: Array<{ generator: string; path: string }> = []

    // Generate Nix workspace (default: disabled)
    const nixEnabled = config.generators?.nix?.enabled === true
    if (nixEnabled) {
      const nixResult = yield* generateNixForRoot({
        outermostRoot: root.value,
        currentRoot: root.value,
        deep: false,
        json,
        depth: 0,
        visited: new Set(),
      })
      if (Option.isSome(nixResult)) {
        results.push({ generator: 'nix', path: nixResult.value.result.workspaceRoot })
      }
      if (!json) {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.envrc.generated.megarepo')}`,
        )
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.direnv/megarepo-nix/workspace')}`,
        )
      }
    }

    // Generate VSCode workspace (default: disabled)
    const vscodeEnabled = config.generators?.vscode?.enabled === true
    if (vscodeEnabled) {
      const vscodeResult = yield* generateVscode({
        megarepoRoot: root.value,
        config,
      })
      results.push({ generator: 'vscode', path: vscodeResult.path })
      if (!json) {
        yield* Console.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
        )
      }
    }

    // Generate JSON schema (always enabled for editor support)
    const schemaResult = yield* generateSchema({
      megarepoRoot: root.value,
      config,
    })
    results.push({ generator: 'schema', path: schemaResult.path })
    if (!json) {
      yield* Console.log(
        `${styled.green(symbols.check)} Generated ${styled.bold('schema/megarepo.schema.json')}`,
      )
    }

    if (json) {
      console.log(JSON.stringify({ status: 'generated', results }))
    } else {
      yield* Console.log('')
      yield* Console.log(styled.dim(`Generated ${results.length} file(s)`))
    }
  }).pipe(Effect.withSpan('megarepo/generate/all')),
).pipe(Cli.Command.withDescription('Generate all configured outputs'))

/** Generate subcommand group */
const generateCommand = Cli.Command.make('generate', {}).pipe(
  Cli.Command.withSubcommands([
    generateAllCommand,
    generateNixCommand,
    generateSchemaCommand,
    generateVscodeCommand,
  ]),
  Cli.Command.withDescription('Generate configuration files'),
)

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
export const mrCommand = Cli.Command.make('mr', {}).pipe(
  Cli.Command.withSubcommands([
    initCommand,
    rootCommand,
    envCommand,
    statusCommand,
    lsCommand,
    syncCommand,
    addCommand,
    updateCommand,
    pinCommand,
    unpinCommand,
    execCommand,
    storeCommand,
    generateCommand,
  ]),
  Cli.Command.withDescription('Multi-repo workspace management tool'),
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: MR_VERSION,
})(process.argv).pipe(Effect.provide(Cwd.live))
