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
import { EffectPath, type AbsoluteDirPath, type AbsoluteFilePath } from '@overeng/effect-path'

import {
  CONFIG_FILE_NAME,
  DEFAULT_STORE_PATH,
  ENV_VARS,
  MegarepoConfig,
  type MemberConfig,
  type MemberSource,
  parseMemberSource,
} from '../lib/config.ts'
import { generateEnvrc } from '../lib/generators/envrc.ts'
import { generateSchema } from '../lib/generators/schema.ts'
import { generateVscode } from '../lib/generators/vscode.ts'
import * as Git from '../lib/git.ts'
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
 * Find megarepo root by searching up from current directory
 */
const findMegarepoRoot = (startPath: AbsoluteDirPath) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    let current = startPath
    const rootDir = EffectPath.unsafe.absoluteDir('/')
    while (current !== rootDir) {
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

    // Check root as well
    const rootConfigPath = EffectPath.ops.join(
      rootDir,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const rootExists = yield* fs.exists(rootConfigPath)
    if (rootExists) {
      return Option.some(rootDir)
    }

    return Option.none()
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
      for (const [name, memberConfig] of Object.entries(config.members)) {
        const source = memberConfig.github ?? memberConfig.url ?? memberConfig.path ?? 'unknown'
        yield* Effect.log(`${styled.bold(name)} ${styled.dim(`(${source})`)}`)
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
  readonly status: 'cloned' | 'symlinked' | 'already_linked' | 'isolated' | 'skipped' | 'error'
  readonly message?: string
}

/**
 * Get the git clone URL for a member source
 */
const getCloneUrl = (source: MemberSource): string => {
  switch (source.type) {
    case 'github':
      return `git@github.com:${source.owner}/${source.repo}.git`
    case 'url':
      return source.url
    case 'path':
      // For local paths, return the path itself (we'll just symlink to it)
      return source.path
  }
}

/**
 * Sync a single member: clone to store if needed, then symlink to workspace
 */
const syncMember = (
  name: string,
  memberConfig: MemberConfig,
  megarepoRoot: AbsoluteDirPath,
  dryRun: boolean,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const store = yield* Store

    // Parse the member source
    const source = parseMemberSource(memberConfig)
    if (source === undefined) {
      return {
        name,
        status: 'error',
        message: 'No source specified (github, url, or path)',
      } satisfies MemberSyncResult
    }

    // Handle local path sources differently - they're already "in store"
    if (source.type === 'path') {
      const memberPath = EffectPath.ops.join(
        megarepoRoot,
        EffectPath.unsafe.relativeDir(`${name}/`),
      )
      const linkExists = yield* fs.exists(memberPath)

      if (linkExists) {
        // Check if it's a symlink pointing to the right place
        const stat = yield* fs.stat(memberPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
        if (stat?.type === 'SymbolicLink') {
          return { name, status: 'already_linked' } satisfies MemberSyncResult
        }
        // Directory exists but isn't a symlink - could be isolated or conflict
        return {
          name,
          status: 'skipped',
          message: 'Directory exists but is not a symlink',
        } satisfies MemberSyncResult
      }

      if (!dryRun) {
        // Create symlink to local path
        yield* fs.symlink(source.path, memberPath)
      }

      return { name, status: 'symlinked' } satisfies MemberSyncResult
    }

    // For remote sources (github, url), check store
    const storePath = store.getRepoPath(source)
    const storeExists = yield* store.hasRepo(source)

    // Clone to store if needed
    if (!storeExists) {
      if (!dryRun) {
        // Ensure parent directories exist
        const parentDir = EffectPath.ops.parent(storePath)
        yield* fs.makeDirectory(parentDir, { recursive: true })

        // Clone the repo
        const cloneUrl = getCloneUrl(source)
        yield* Git.clone({ url: cloneUrl, targetPath: storePath })

        // Checkout pinned ref if specified
        if (memberConfig.pin !== undefined) {
          yield* Git.checkout({ repoPath: storePath, ref: memberConfig.pin })
        }
      }
    }

    // Check if member should be isolated (worktree instead of symlink)
    if (memberConfig.isolated !== undefined) {
      const memberPath = EffectPath.ops.join(
        megarepoRoot,
        EffectPath.unsafe.relativeDir(`${name}/`),
      )
      const memberExists = yield* fs.exists(memberPath)

      if (memberExists) {
        // Check if it's already a worktree
        const isGitWorktree = yield* fs
          .exists(EffectPath.ops.join(memberPath, EffectPath.unsafe.relativeFile('.git')))
          .pipe(
            Effect.map((exists) => exists),
            Effect.catchAll(() => Effect.succeed(false)),
          )
        if (isGitWorktree) {
          return { name, status: 'already_linked' } satisfies MemberSyncResult
        }
        // Remove symlink to replace with worktree
        if (!dryRun) {
          yield* fs.remove(memberPath)
        }
      }

      if (!dryRun) {
        // Create worktree for isolated member
        yield* Git.createWorktree({
          repoPath: storePath,
          worktreePath: memberPath,
          branch: memberConfig.isolated,
          createBranch: false, // Assume branch exists
        }).pipe(
          Effect.catchAll(() =>
            // If branch doesn't exist, create it
            Git.createWorktree({
              repoPath: storePath,
              worktreePath: memberPath,
              branch: memberConfig.isolated!,
              createBranch: true,
            }),
          ),
        )
      }

      return {
        name,
        status: storeExists ? 'isolated' : 'cloned',
        message: `isolated on branch ${memberConfig.isolated}`,
      } satisfies MemberSyncResult
    }

    // Create symlink from workspace to store
    const memberPath = EffectPath.ops.join(megarepoRoot, EffectPath.unsafe.relativeDir(`${name}/`))
    const linkExists = yield* fs.exists(memberPath)

    if (linkExists) {
      // Check if it's a symlink pointing to the right place
      const stat = yield* fs.stat(memberPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (stat?.type === 'SymbolicLink') {
        // Symlink exists - check if it points to correct location
        const target = yield* fs.readLink(memberPath)
        // Compare paths (remove trailing slash for comparison)
        const storePathStr = storePath.replace(/\/$/, '')
        const targetStr = target.replace(/\/$/, '')
        if (targetStr === storePathStr) {
          return { name, status: 'already_linked' } satisfies MemberSyncResult
        }
        // Wrong target - remove and recreate
        if (!dryRun) {
          yield* fs.remove(memberPath)
        }
      } else {
        // Directory exists but isn't a symlink - conflict
        return {
          name,
          status: 'error',
          message: 'Directory exists but is not a symlink. Remove it manually or use mr isolate.',
        } satisfies MemberSyncResult
      }
    }

    if (!dryRun) {
      yield* fs.symlink(storePath, memberPath)
    }

    return {
      name,
      status: storeExists ? 'symlinked' : 'cloned',
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
    deep: Cli.Options.boolean('deep').pipe(
      Cli.Options.withDescription('Recursively sync nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ json, dryRun, deep }) =>
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

      const members = Object.entries(config.members)
      const results: MemberSyncResult[] = []
      const nestedMegarepos: string[] = []

      if (!json && dryRun) {
        yield* Effect.log(styled.dim('Dry run - no changes will be made'))
      }

      // Sync each member
      for (const [name, memberConfig] of members) {
        const result = yield* syncMember(name, memberConfig, root.value, dryRun)
        results.push(result)

        if (!json) {
          const statusSymbol =
            result.status === 'error'
              ? styled.red(symbols.cross)
              : result.status === 'already_linked'
                ? styled.dim(symbols.check)
                : styled.green(symbols.check)

          const statusText =
            result.status === 'cloned'
              ? 'cloned & linked'
              : result.status === 'symlinked'
                ? 'linked'
                : result.status === 'isolated'
                  ? `isolated (${result.message})`
                  : result.status === 'already_linked'
                    ? 'already linked'
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

      // Output results
      if (json) {
        console.log(JSON.stringify({ results, nestedMegarepos }))
      } else {
        const syncedCount = results.filter(
          (r) => r.status === 'cloned' || r.status === 'symlinked' || r.status === 'isolated',
        ).length
        const alreadyCount = results.filter((r) => r.status === 'already_linked').length
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
 * Parse a repo reference into a member config.
 * Supports:
 * - GitHub shorthand: "owner/repo"
 * - SSH URL: "git@github.com:owner/repo.git"
 * - HTTPS URL: "https://github.com/owner/repo.git"
 * - Local path: "/path/to/repo" or "./relative/path"
 */
const parseRepoRef = (ref: string): { config: MemberConfig; suggestedName: string } | undefined => {
  // Check if it's a GitHub shorthand (owner/repo without protocol)
  const githubMatch = ref.match(/^([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/)
  if (githubMatch?.[1] !== undefined && githubMatch[2] !== undefined) {
    return {
      config: { github: ref },
      suggestedName: githubMatch[2],
    }
  }

  // Check if it's a git URL (SSH or HTTPS)
  const parsed = Git.parseGitRemoteUrl(ref)
  if (Option.isSome(parsed)) {
    return {
      config: { url: ref },
      suggestedName: parsed.value.repo,
    }
  }

  // Check if it looks like a path (starts with /, ./, or ~)
  if (ref.startsWith('/') || ref.startsWith('./') || ref.startsWith('../') || ref.startsWith('~')) {
    const name = ref.split('/').filter(Boolean).pop() ?? 'unknown'
    return {
      config: { path: ref },
      suggestedName: name,
    }
  }

  return undefined
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
          [memberName]: parsed.config,
        },
      }

      // Write updated config
      const newConfigContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
        newConfig,
      )
      yield* fs.writeFileString(configPath, newConfigContent + '\n')

      if (json) {
        console.log(JSON.stringify({ status: 'added', member: memberName, config: parsed.config }))
      } else {
        yield* Effect.log(`${styled.green(symbols.check)} Added ${styled.bold(memberName)}`)
      }

      // Sync if requested
      if (sync) {
        if (!json) {
          yield* Effect.log(styled.dim('Syncing...'))
        }
        const result = yield* syncMember(memberName, parsed.config, root.value, false)
        if (!json) {
          const statusSymbol =
            result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
          const statusText = result.status === 'cloned' ? 'cloned & linked' : result.status
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

/** Update (pull) all repos */
const updateCommand = Cli.Command.make(
  'update',
  {
    json: jsonOption,
    member: Cli.Options.text('member').pipe(
      Cli.Options.withAlias('m'),
      Cli.Options.withDescription('Update only this member'),
      Cli.Options.optional,
    ),
  },
  ({ json, member }) =>
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

      // Filter members if specific one requested
      const membersToUpdate = Option.match(member, {
        onNone: () => Object.keys(config.members),
        onSome: (m) => (m in config.members ? [m] : []),
      })

      if (membersToUpdate.length === 0) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Member not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const results: Array<{
        name: string
        status: 'updated' | 'skipped' | 'error'
        message?: string
      }> = []

      for (const name of membersToUpdate) {
        const memberPath = EffectPath.ops.join(
          root.value,
          EffectPath.unsafe.relativeDir(`${name}/`),
        )
        const exists = yield* fs.exists(memberPath)

        if (!exists) {
          results.push({ name, status: 'skipped', message: 'Not synced yet' })
          continue
        }

        // Fetch and pull
        const result = yield* Effect.gen(function* () {
          yield* Git.fetch({ repoPath: memberPath, prune: true })
          // Try to pull (fast-forward only)
          const branch = yield* Git.getCurrentBranch(memberPath)
          if (Option.isSome(branch)) {
            yield* Effect.gen(function* () {
              const cmd = Command.make('git', 'pull', '--ff-only').pipe(
                Command.workingDirectory(memberPath),
              )
              yield* Command.string(cmd)
            }).pipe(Effect.catchAll(() => Effect.void))
          }
          return { name, status: 'updated' as const }
        }).pipe(
          Effect.catchAll((error) =>
            Effect.succeed({
              name,
              status: 'error' as const,
              message: error instanceof Error ? error.message : String(error),
            }),
          ),
        )

        results.push(result)

        if (!json) {
          const statusSymbol =
            result.status === 'error' ? styled.red(symbols.cross) : styled.green(symbols.check)
          yield* Effect.log(
            `${statusSymbol} ${styled.bold(name)} ${styled.dim(`(${result.status})`)}`,
          )
        }
      }

      if (json) {
        console.log(JSON.stringify({ results }))
      } else {
        const updatedCount = results.filter((r) => r.status === 'updated').length
        const errorCount = results.filter((r) => r.status === 'error').length
        yield* Effect.log('')
        yield* Effect.log(styled.dim(`Updated ${updatedCount} member(s)`))
        if (errorCount > 0) {
          yield* Effect.log(styled.red(`${errorCount} error(s)`))
        }
      }
    }).pipe(Effect.withSpan('megarepo/update')),
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
// Isolate Command
// =============================================================================

/** Isolate a member (convert symlink to worktree) */
const isolateCommand = Cli.Command.make(
  'isolate',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to isolate')),
    branch: Cli.Args.text({ name: 'branch' }).pipe(
      Cli.Args.withDescription('Branch name for the worktree'),
    ),
    json: jsonOption,
  },
  ({ member, branch, json }) =>
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

      // Check if member exists
      const memberConfig = config.members[member]
      if (memberConfig === undefined) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Member '${member}' not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      const memberPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeDir(`${member}/`),
      )
      const store = yield* Store
      const source = parseMemberSource(memberConfig)

      if (source === undefined || source.type === 'path') {
        if (json) {
          console.log(
            JSON.stringify({ error: 'invalid', message: 'Cannot isolate local path members' }),
          )
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Cannot isolate local path members`)
        }
        return yield* Effect.fail(new Error('Cannot isolate local path members'))
      }

      const storePath = store.getRepoPath(source)

      // Remove existing symlink
      const exists = yield* fs.exists(memberPath)
      if (exists) {
        yield* fs.remove(memberPath)
      }

      // Create worktree
      yield* Git.createWorktree({
        repoPath: storePath,
        worktreePath: memberPath,
        branch,
        createBranch: false,
      }).pipe(
        Effect.catchAll(() =>
          Git.createWorktree({
            repoPath: storePath,
            worktreePath: memberPath,
            branch,
            createBranch: true,
          }),
        ),
      )

      // Update config with isolated field
      const newConfig = {
        ...config,
        members: {
          ...config.members,
          [member]: { ...memberConfig, isolated: branch },
        },
      }
      const newConfigContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
        newConfig,
      )
      yield* fs.writeFileString(configPath, newConfigContent + '\n')

      if (json) {
        console.log(JSON.stringify({ status: 'isolated', member, branch }))
      } else {
        yield* Effect.log(
          `${styled.green(symbols.check)} Isolated ${styled.bold(member)} on branch ${styled.bold(branch)}`,
        )
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/isolate')),
)

/** Unisolate a member (convert worktree back to symlink) */
const unisolateCommand = Cli.Command.make(
  'unisolate',
  {
    member: Cli.Args.text({ name: 'member' }).pipe(Cli.Args.withDescription('Member to unisolate')),
    json: jsonOption,
    force: Cli.Options.boolean('force').pipe(
      Cli.Options.withAlias('f'),
      Cli.Options.withDescription('Force removal even with uncommitted changes'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ member, json, force }) =>
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

      // Check if member exists and is isolated
      const memberConfig = config.members[member]
      if (memberConfig === undefined) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_found', message: 'Member not found' }))
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Member '${member}' not found`)
        }
        return yield* Effect.fail(new Error('Member not found'))
      }

      if (memberConfig.isolated === undefined) {
        if (json) {
          console.log(JSON.stringify({ error: 'not_isolated', message: 'Member is not isolated' }))
        } else {
          yield* Effect.logError(`${styled.red(symbols.cross)} Member '${member}' is not isolated`)
        }
        return yield* Effect.fail(new Error('Member is not isolated'))
      }

      const memberPath = EffectPath.ops.join(
        root.value,
        EffectPath.unsafe.relativeDir(`${member}/`),
      )
      const store = yield* Store
      const source = parseMemberSource(memberConfig)

      if (source === undefined || source.type === 'path') {
        return yield* Effect.fail(new Error('Invalid member source'))
      }

      const storePath = store.getRepoPath(source)

      // Remove worktree
      yield* Git.removeWorktree({ repoPath: storePath, worktreePath: memberPath, force })

      // Create symlink
      yield* fs.symlink(storePath, memberPath)

      // Update config to remove isolated field
      const { isolated: _, ...cleanMemberConfig } = memberConfig
      const newConfig = {
        ...config,
        members: {
          ...config.members,
          [member]: cleanMemberConfig,
        },
      }
      const newConfigContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
        newConfig,
      )
      yield* fs.writeFileString(configPath, newConfigContent + '\n')

      if (json) {
        console.log(JSON.stringify({ status: 'unisolated', member }))
      } else {
        yield* Effect.log(`${styled.green(symbols.check)} Unisolated ${styled.bold(member)}`)
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/unisolate')),
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

/** Store subcommand group */
const storeCommand = Cli.Command.make('store', {}).pipe(
  Cli.Command.withSubcommands([storeLsCommand, storeFetchCommand]),
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
        exclude: Option.getOrUndefined(excludeList),
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

    // Generate envrc
    const envrcResult = yield* generateEnvrc({
      megarepoRoot: root.value,
      config,
    })
    results.push({ generator: 'envrc', path: envrcResult.path })
    if (!json) {
      yield* Effect.log(`${styled.green(symbols.check)} Generated ${styled.bold('.envrc.local')}`)
    }

    // Generate VSCode workspace
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
    execCommand,
    isolateCommand,
    unisolateCommand,
    storeCommand,
    generateCommand,
  ]),
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: '0.1.0',
})(process.argv).pipe(Effect.provide(Cwd.live))
