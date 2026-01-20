/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { Command, FileSystem } from '@effect/platform'
import { Context, Effect, Layer, Option, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import {
  CONFIG_FILE_NAME,
  ENV_VARS,
  getSourceRef,
  getSourceUrl,
  isRemoteSource,
  MegarepoConfig,
  type MemberSource,
  parseSourceString,
  validateMemberName,
} from '../lib/config.ts'
import { generateEnvrc } from '../lib/generators/envrc.ts'
import { generateSchema } from '../lib/generators/schema.ts'
import { generateVscode } from '../lib/generators/vscode.ts'
import * as Git from '../lib/git.ts'
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
  updateLockedMember,
  writeLockFile,
} from '../lib/lock.ts'
import { classifyRef } from '../lib/ref.ts'
import { Store, StoreLayer } from '../lib/store.ts'

// =============================================================================
// CLI Context Services
// =============================================================================

/** Current working directory service */
export class Cwd extends Context.Tag('megarepo/Cwd')<Cwd, AbsoluteDirPath>() {
  static live = Layer.effect(
    Cwd,
    Effect.sync(() => EffectPath.unsafe.absoluteDir(`${process.cwd()}/`)),
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
        console.log(JSON.stringify({ error: 'not_git_repo', message: 'Not a git repository' }))
      } else {
        yield* Effect.logError(
          `${styled.red(symbols.cross)} Not a git repository. Run 'git init' first.`,
        )
      }
      return yield* Effect.fail(new Error('Not a git repository'))
    }

    const configPath = EffectPath.ops.join(cwd, EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME))

    // Check if config already exists
    const exists = yield* fs.exists(configPath)
    if (exists) {
      if (json) {
        console.log(JSON.stringify({ status: 'already_initialized', path: configPath }))
      } else {
        yield* Effect.log(styled.dim('megarepo already initialized'))
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
      yield* Effect.log(
        `${styled.green(symbols.check)} ${styled.dim('initialized megarepo at')} ${styled.bold(path.basename(cwd))}`,
      )
    }
  }).pipe(Effect.withSpan('megarepo/init')),
)

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

/** Find and print the megarepo root directory */
const rootCommand = Cli.Command.make('root', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd

    // If MEGAREPO_ROOT is set and valid, use that
    const envRoot = process.env[ENV_VARS.ROOT]
    if (envRoot !== undefined) {
      const fs = yield* FileSystem.FileSystem
      const envRootDir = EffectPath.unsafe.absoluteDir(
        envRoot.endsWith('/') ? envRoot : `${envRoot}/`,
      )
      const configPath = EffectPath.ops.join(
        envRootDir,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const exists = yield* fs.exists(configPath)

      if (exists) {
        const name = yield* Git.deriveMegarepoName(envRootDir)
        if (json) {
          console.log(JSON.stringify({ root: envRootDir, name, source: 'env' }))
        } else {
          console.log(envRootDir)
        }
        return
      }
    }

    // Search up from current directory
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Effect.logError(
          `${styled.red(symbols.cross)} No megarepo.json found in current directory or any parent.`,
        )
      }
      return yield* Effect.fail(new Error('Not in a megarepo'))
    }

    const name = yield* Git.deriveMegarepoName(root.value)

    if (json) {
      console.log(JSON.stringify({ root: root.value, name, source: 'search' }))
    } else {
      console.log(root.value)
    }
  }).pipe(Effect.withSpan('megarepo/root')),
)

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

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} No megarepo.json found`)
        }
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
            [ENV_VARS.ROOT]: root.value,
            [ENV_VARS.MEMBERS]: memberNames,
          }),
        )
      } else {
        // Output shell-specific format
        switch (shell) {
          case 'fish':
            console.log(`set -gx ${ENV_VARS.ROOT} "${root.value}"`)
            console.log(`set -gx ${ENV_VARS.MEMBERS} "${memberNames}"`)
            break
          default:
            console.log(`export ${ENV_VARS.ROOT}="${root.value}"`)
            console.log(`export ${ENV_VARS.MEMBERS}="${memberNames}"`)
        }
      }
    }).pipe(Effect.withSpan('megarepo/env')),
)

// =============================================================================
// Status Command (placeholder)
// =============================================================================

/** Show megarepo status */
const statusCommand = Cli.Command.make('status', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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

    const name = yield* Git.deriveMegarepoName(root.value)
    const memberCount = Object.keys(config.members).length

    if (json) {
      console.log(
        JSON.stringify({
          name,
          root: root.value,
          memberCount,
          members: Object.keys(config.members),
        }),
      )
    } else {
      yield* Effect.log(`${styled.bold(name)}`)
      yield* Effect.log(styled.dim(`  root: ${root.value}`))
      yield* Effect.log(styled.dim(`  members: ${memberCount}`))

      for (const [memberName] of Object.entries(config.members)) {
        const memberPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeDir(`${memberName}/`),
        )
        const memberExists = yield* fs.exists(memberPath)
        const status = memberExists ? styled.green(symbols.check) : styled.yellow('○')
        yield* Effect.log(`  ${status} ${memberName}`)
      }
    }
  }).pipe(Effect.withSpan('megarepo/status')),
)

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
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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

    if (json) {
      console.log(JSON.stringify({ members: config.members }))
    } else {
      for (const [name, sourceString] of Object.entries(config.members)) {
        yield* Effect.log(`${styled.bold(name)} ${styled.dim(`(${sourceString})`)}`)
      }
    }
  }).pipe(Effect.withSpan('megarepo/ls')),
)

// =============================================================================
// Sync Command
// =============================================================================

/** Member sync result */
interface MemberSyncResult {
  readonly name: string
  readonly status: 'cloned' | 'synced' | 'already_synced' | 'skipped' | 'error'
  readonly message?: string | undefined
  /** Resolved commit for lock file (remote sources only) */
  readonly commit?: string | undefined
  /** Resolved ref for lock file */
  readonly ref?: string | undefined
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
 */
const syncMember = ({
  name,
  sourceString,
  megarepoRoot,
  lockFile,
  dryRun,
  frozen,
}: {
  name: string
  sourceString: string
  megarepoRoot: AbsoluteDirPath
  lockFile: LockFile | undefined
  dryRun: boolean
  frozen: boolean
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

    const memberPath = EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeDir(`${name}/`))

    // Handle local path sources - just create symlink
    if (source.type === 'path') {
      const expandedPath = source.path.replace(/^~/, process.env.HOME ?? '~')
      const linkExists = yield* fs.exists(memberPath)

      if (linkExists) {
        const stat = yield* fs.stat(memberPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (stat?.type === 'SymbolicLink') {
          const target = yield* fs.readLink(memberPath)
          if (target.replace(/\/$/, '') === expandedPath.replace(/\/$/, '')) {
            return { name, status: 'already_synced' } satisfies MemberSyncResult
          }
          if (!dryRun) {
            yield* fs.remove(memberPath)
          }
        } else {
          return {
            name,
            status: 'skipped',
            message: 'Directory exists but is not a symlink',
          } satisfies MemberSyncResult
        }
      }

      if (!dryRun) {
        yield* createSymlink({ target: expandedPath, link: memberPath })
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
    } else if (!frozen && !dryRun) {
      // Fetch updates (unless frozen)
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
    const worktreePath = store.getWorktreePath({ source, ref: targetRef })
    const worktreeExists = yield* store.hasWorktree({ source, ref: targetRef })

    if (!worktreeExists && !dryRun) {
      // Ensure worktree parent directory exists
      const worktreeParent = EffectPath.ops.parent(worktreePath)
      if (worktreeParent !== undefined) {
        yield* fs.makeDirectory(worktreeParent, { recursive: true })
      }

      // Create worktree
      const refType = classifyRef(targetRef)
      if (refType === 'commit' || refType === 'tag') {
        yield* Git.createWorktreeDetached({
          repoPath: bareRepoPath,
          worktreePath,
          commit: targetCommit ?? targetRef,
        })
      } else {
        // Branch worktree
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
    const linkExists = yield* fs.exists(memberPath)
    if (linkExists) {
      const stat = yield* fs.stat(memberPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (stat?.type === 'SymbolicLink') {
        const target = yield* fs.readLink(memberPath)
        if (target.replace(/\/$/, '') === worktreePath.replace(/\/$/, '')) {
          return {
            name,
            status: 'already_synced',
            commit: targetCommit,
            ref: targetRef,
          } satisfies MemberSyncResult
        }
        if (!dryRun) {
          yield* fs.remove(memberPath)
        }
      } else {
        return {
          name,
          status: 'skipped',
          message: 'Directory exists but is not a symlink',
        } satisfies MemberSyncResult
      }
    }

    if (!dryRun) {
      yield* createSymlink({ target: worktreePath, link: memberPath })
    }

    return {
      name,
      status: wasCloned ? 'cloned' : 'synced',
      commit: targetCommit,
      ref: targetRef,
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

/** Sync members: clone to store and create symlinks */
const syncCommand = Cli.Command.make(
  'sync',
  {
    json: jsonOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would be done without making changes'),
      Cli.Options.withDefault(false),
    ),
    frozen: Cli.Options.boolean('frozen').pipe(
      Cli.Options.withDescription(
        'Use exact commits from lock file (fail if lock missing or stale)',
      ),
      Cli.Options.withDefault(false),
    ),
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively sync nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, dryRun, frozen, deep }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      if (Option.isNone(root)) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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

      // Load lock file (optional unless --frozen)
      const lockPath = EffectPath.ops.join(
        root.value,
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
              JSON.stringify({ error: 'no_lock', message: 'Lock file required for --frozen' }),
            )
          } else {
            yield* Effect.logError(
              `${styled.red(symbols.cross)} Lock file required for --frozen mode`,
            )
          }
          return yield* Effect.fail(new Error('Lock file required for --frozen'))
        }

        // Check for staleness
        const staleness = checkLockStaleness({ lockFile, configMemberNames: remoteMemberNames })
        if (staleness.isStale) {
          if (json) {
            console.log(
              JSON.stringify({
                error: 'stale_lock',
                message: 'Lock file is stale',
                added: staleness.addedMembers,
                removed: staleness.removedMembers,
              }),
            )
          } else {
            yield* Effect.logError(`${styled.red(symbols.cross)} Lock file is stale`)
            if (staleness.addedMembers.length > 0) {
              yield* Effect.log(styled.dim(`  Added: ${staleness.addedMembers.join(', ')}`))
            }
            if (staleness.removedMembers.length > 0) {
              yield* Effect.log(styled.dim(`  Removed: ${staleness.removedMembers.join(', ')}`))
            }
          }
          return yield* Effect.fail(new Error('Lock file is stale'))
        }
      }

      const members = Object.entries(config.members)
      const results: MemberSyncResult[] = []
      const nestedMegarepos: string[] = []

      if (!json && dryRun) {
        yield* Effect.log(styled.dim('Dry run - no changes will be made'))
      }
      if (!json && frozen) {
        yield* Effect.log(styled.dim('Frozen mode - using exact commits from lock file'))
      }

      // Sync each member
      for (const [name, sourceString] of members) {
        const result = yield* syncMember({
          name,
          sourceString,
          megarepoRoot: root.value,
          lockFile,
          dryRun,
          frozen,
        })
        results.push(result)

        if (!json) {
          const statusSymbol =
            result.status === 'error'
              ? styled.red(symbols.cross)
              : result.status === 'already_synced'
                ? styled.dim(symbols.check)
                : styled.green(symbols.check)

          const statusText =
            result.status === 'cloned'
              ? 'cloned'
              : result.status === 'synced'
                ? 'synced'
                : result.status === 'already_synced'
                  ? 'already synced'
                  : result.status === 'error'
                    ? `error: ${result.message}`
                    : result.status

          yield* Effect.log(`${statusSymbol} ${styled.bold(name)} ${styled.dim(`(${statusText})`)}`)
        }

        // Check if this member is itself a megarepo (for --deep hint)
        if (result.status !== 'error' && result.status !== 'skipped') {
          const memberPath = EffectPath.ops.join(
            root.value,
            EffectPath.unsafe.relativeDir(`${name}/`),
          )
          const nestedConfigPath = EffectPath.ops.join(
            memberPath,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const hasNestedConfig = yield* fs.exists(nestedConfigPath)
          if (hasNestedConfig) {
            nestedMegarepos.push(name)
          }
        }
      }

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
          if (result.commit !== undefined && result.ref !== undefined) {
            const sourceString = config.members[result.name]
            if (sourceString === undefined) continue
            const source = parseSourceString(sourceString)
            if (source === undefined || !isRemoteSource(source)) continue

            const url = getSourceUrl(source) ?? sourceString
            const existingLocked = lockFile.members[result.name]

            lockFile = updateLockedMember({
              lockFile,
              memberName: result.name,
              member: createLockedMember({
                url,
                ref: result.ref,
                commit: result.commit,
                pinned: existingLocked?.pinned ?? false,
              }),
            })
          }
        }

        // Write lock file
        yield* writeLockFile({ lockPath, lockFile })
      }

      // Output results
      if (json) {
        console.log(JSON.stringify({ results, nestedMegarepos }))
      } else {
        const syncedCount = results.filter(
          (r) => r.status === 'cloned' || r.status === 'synced',
        ).length
        const alreadyCount = results.filter((r) => r.status === 'already_synced').length
        const errorCount = results.filter((r) => r.status === 'error').length

        yield* Effect.log('')
        if (dryRun) {
          yield* Effect.log(
            styled.dim(`Would sync ${syncedCount} members, ${alreadyCount} already synced`),
          )
        } else {
          yield* Effect.log(
            styled.dim(`Synced ${syncedCount} members, ${alreadyCount} already synced`),
          )
        }

        if (errorCount > 0) {
          yield* Effect.log(styled.red(`${errorCount} errors`))
        }

        // Show hint about nested megarepos
        if (nestedMegarepos.length > 0 && !deep) {
          yield* Effect.log('')
          yield* Effect.log(
            styled.dim(
              `Note: ${nestedMegarepos.length} member(s) contain nested megarepos (${nestedMegarepos.join(', ')})`,
            ),
          )
          yield* Effect.log(
            styled.dim(`      Run 'mr sync --deep' to sync them, or 'cd <member> && mr sync'`),
          )
        }
      }

      // Handle --deep flag
      if (deep && nestedMegarepos.length > 0 && !dryRun) {
        yield* Effect.log('')
        yield* Effect.log(styled.bold('Syncing nested megarepos...'))

        for (const nestedName of nestedMegarepos) {
          yield* Effect.log(styled.dim(`  → ${nestedName}`))
          // For now, just log - recursive sync would require more infrastructure
          // TODO: Implement recursive sync by calling sync command with different cwd
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/sync')),
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Invalid repo reference: ${repo}`)
          yield* Effect.log(
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
          yield* Effect.logError(
            `${styled.red(symbols.cross)} Member '${memberName}' already exists`,
          )
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
        yield* Effect.log(`${styled.green(symbols.check)} Added ${styled.bold(memberName)}`)
      }

      // Sync if requested
      if (sync) {
        if (!json) {
          yield* Effect.log(styled.dim('Syncing...'))
        }
        const result = yield* syncMember({
          name: memberName,
          sourceString: parsed.sourceString,
          megarepoRoot: root.value,
          lockFile: undefined,
          dryRun: false,
          frozen: false,
        })
        if (!json) {
          const statusSymbol =
            result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
          const statusText = result.status === 'cloned' ? 'cloned' : result.status
          yield* Effect.log(
            `${statusSymbol} ${styled.bold(memberName)} ${styled.dim(`(${statusText})`)}`,
          )
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/add')),
)

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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Member not found`)
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

          yield* Effect.log(`${statusSymbol} ${styled.bold(name)} ${styled.dim(`(${statusText})`)}`)
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

            lockFile = updateLockedMember({
              lockFile,
              memberName: name,
              member: createLockedMember({
                url,
                ref,
                commit: result.newCommit,
                pinned: existingLocked?.pinned ?? false,
              }),
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

        yield* Effect.log('')
        const parts: string[] = []
        if (updatedCount > 0) parts.push(`${updatedCount} updated`)
        if (skippedCount > 0) parts.push(`${skippedCount} skipped`)
        if (pinnedCount > 0) parts.push(`${pinnedCount} pinned`)
        yield* Effect.log(styled.dim(parts.join(', ')))

        if (errorCount > 0) {
          yield* Effect.log(styled.red(`${errorCount} error(s)`))
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/update')),
)

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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Member not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const results: Array<{ name: string; exitCode: number; stdout: string; stderr: string }> = []

      for (const name of membersToRun) {
        const memberPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeDir(`${name}/`),
        )
        const exists = yield* fs.exists(memberPath)

        if (!exists) {
          results.push({ name, exitCode: -1, stdout: '', stderr: 'Member not synced' })
          continue
        }

        if (!json) {
          yield* Effect.log(styled.bold(`\n${name}:`))
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
)

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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Member '${member}' not found`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Invalid source string`)
        }
        return yield* Effect.fail(new Error('Invalid source'))
      }
      if (!isRemoteSource(source)) {
        if (json) {
          console.log(
            JSON.stringify({ error: 'local_path', message: 'Cannot pin local path members' }),
          )
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Cannot pin local path members`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Member '${member}' not synced yet.`)
          yield* Effect.log(styled.dim('  Run: mr sync'))
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
          yield* Effect.log(
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
        yield* Effect.log(
          `${styled.green(symbols.check)} Pinned ${styled.bold(member)} at ${styled.dim(lockedMember.commit.slice(0, 7))}`,
        )
      }
    }).pipe(Effect.withSpan('megarepo/pin')),
)

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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Member '${member}' not found`)
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
          yield* Effect.logError(`${styled.red(symbols.cross)} No lock file found`)
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
          yield* Effect.log(styled.dim(`Member '${member}' not in lock file`))
        }
        return
      }

      // Check if already unpinned
      if (!lockedMember.pinned) {
        if (json) {
          console.log(JSON.stringify({ status: 'already_unpinned', member }))
        } else {
          yield* Effect.log(styled.dim(`Member '${member}' is not pinned`))
        }
        return
      }

      // Unpin the member
      lockFile = unpinMember({ lockFile, memberName: member })
      yield* writeLockFile({ lockPath, lockFile })

      if (json) {
        console.log(JSON.stringify({ status: 'unpinned', member }))
      } else {
        yield* Effect.log(`${styled.green(symbols.check)} Unpinned ${styled.bold(member)}`)
      }
    }).pipe(Effect.withSpan('megarepo/unpin')),
)

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
      if (repos.length === 0) {
        yield* Effect.log(styled.dim('Store is empty'))
      } else {
        yield* Effect.log(styled.bold(`Store: ${store.basePath}`))
        yield* Effect.log('')
        for (const repo of repos) {
          yield* Effect.log(`  ${repo.relativePath}`)
        }
        yield* Effect.log('')
        yield* Effect.log(styled.dim(`${repos.length} repo(s)`))
      }
    }
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/ls')),
)

/** Fetch all repos in the store */
const storeFetchCommand = Cli.Command.make('fetch', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const store = yield* Store
    const repos = yield* store.listRepos()

    const results: Array<{ path: string; status: 'fetched' | 'error'; message?: string }> = []

    for (const repo of repos) {
      const result = yield* Git.fetch({ repoPath: repo.fullPath, prune: true }).pipe(
        Effect.map(() => ({ path: repo.relativePath, status: 'fetched' as const })),
        Effect.catchAll((error) =>
          Effect.succeed({
            path: repo.relativePath,
            status: 'error' as const,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
      )
      results.push(result)

      if (!json) {
        const symbol =
          result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
        yield* Effect.log(`${symbol} ${repo.relativePath}`)
      }
    }

    if (json) {
      console.log(JSON.stringify({ results }))
    } else {
      const fetchedCount = results.filter((r) => r.status === 'fetched').length
      yield* Effect.log('')
      yield* Effect.log(styled.dim(`Fetched ${fetchedCount} repo(s)`))
    }
  }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/fetch')),
)

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
        yield* Effect.log(styled.dim('Not in a megarepo - all worktrees will be considered unused'))
        yield* Effect.log('')
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

        if (removed.length > 0) {
          const verb = dryRun ? 'Would remove' : 'Removed'
          for (const r of removed) {
            yield* Effect.log(`${styled.green(symbols.check)} ${verb} ${r.repo}refs/${r.ref}`)
          }
        }

        if (skippedDirty.length > 0) {
          yield* Effect.log('')
          yield* Effect.log(styled.yellow('Skipped (dirty):'))
          for (const r of skippedDirty) {
            yield* Effect.log(
              `  ${styled.yellow('⊘')} ${r.repo}refs/${r.ref} ${styled.dim(`(${r.message})`)}`,
            )
          }
          if (!force) {
            yield* Effect.log(styled.dim('  Use --force to remove dirty worktrees'))
          }
        }

        yield* Effect.log('')
        const parts: string[] = []
        if (removed.length > 0) parts.push(`${removed.length} ${dryRun ? 'would be ' : ''}removed`)
        if (skippedDirty.length > 0) parts.push(`${skippedDirty.length} dirty`)
        if (skippedInUse.length > 0) parts.push(`${skippedInUse.length} in use`)
        yield* Effect.log(styled.dim(parts.length > 0 ? parts.join(', ') : 'Nothing to clean up'))
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/store/gc')),
)

/** Store subcommand group */
const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([storeLsCommand, storeFetchCommand, storeGcCommand]),
)

// =============================================================================
// Generate Command
// =============================================================================

/** Generate envrc file */
const generateEnvrcCommand = Cli.Command.make('envrc', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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

    const result = yield* generateEnvrc({
      megarepoRoot: root.value,
      config,
    })

    if (json) {
      console.log(JSON.stringify({ status: 'generated', path: result.path }))
    } else {
      yield* Effect.log(`${styled.green(symbols.check)} Generated ${styled.bold('.envrc.local')}`)
    }
  }).pipe(Effect.withSpan('megarepo/generate/envrc')),
)

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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
        yield* Effect.log(
          `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.code-workspace')}`,
        )
      }
    }).pipe(Effect.withSpan('megarepo/generate/vscode')),
)

/** Generate JSON Schema */
const generateSchemaCommand = Cli.Command.make(
  'schema',
  {
    json: jsonOption,
    output: Cli.Options.text('output').pipe(
      Cli.Options.withAlias('o'),
      Cli.Options.withDescription('Output path (relative to megarepo root)'),
      Cli.Options.withDefault('megarepo.schema.json'),
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
          yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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
        yield* Effect.log(`${styled.green(symbols.check)} Generated ${styled.bold(output)}`)
      }
    }).pipe(Effect.withSpan('megarepo/generate/schema')),
)

/** Generate all configured outputs */
const generateAllCommand = Cli.Command.make('all', { json: jsonOption }, ({ json }) =>
  Effect.gen(function* () {
    const cwd = yield* Cwd
    const root = yield* findMegarepoRoot(cwd)

    if (Option.isNone(root)) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_found', message: 'No megarepo.json found' }))
      } else {
        yield* Effect.logError(`${styled.red(symbols.cross)} Not in a megarepo`)
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

    // Generate envrc (default: enabled)
    const envrcEnabled = config.generators?.envrc?.enabled !== false
    if (envrcEnabled) {
      const envrcResult = yield* generateEnvrc({
        megarepoRoot: root.value,
        config,
      })
      results.push({ generator: 'envrc', path: envrcResult.path })
      if (!json) {
        yield* Effect.log(`${styled.green(symbols.check)} Generated ${styled.bold('.envrc.local')}`)
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
        yield* Effect.log(
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
      yield* Effect.log(
        `${styled.green(symbols.check)} Generated ${styled.bold('.vscode/megarepo.schema.json')}`,
      )
    }

    if (json) {
      console.log(JSON.stringify({ status: 'generated', results }))
    } else {
      yield* Effect.log('')
      yield* Effect.log(styled.dim(`Generated ${results.length} file(s)`))
    }
  }).pipe(Effect.withSpan('megarepo/generate/all')),
)

/** Generate subcommand group */
const generateCommand = Cli.Command.make('generate', {}).pipe(
  Cli.Command.withSubcommands([
    generateAllCommand,
    generateEnvrcCommand,
    generateSchemaCommand,
    generateVscodeCommand,
  ]),
)

// =============================================================================
// Main CLI
// =============================================================================

/** Root CLI command */
const mrCommand = Cli.Command.make('mr', {}).pipe(
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
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: '0.1.0',
})(process.argv).pipe(Effect.provide(Cwd.live))
