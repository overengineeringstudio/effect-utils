/**
 * Megarepo CLI
 *
 * Main CLI entry point for the `mr` command.
 */

import path from 'node:path'

import * as Cli from '@effect/cli'
import { FileSystem, Path } from '@effect/platform'
import { Context, Effect, Layer, Option, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'

import {
  CONFIG_FILE_NAME,
  DEFAULT_STORE_PATH,
  ENV_VARS,
  getStorePath,
  MegarepoConfig,
  type MemberConfig,
  type MemberSource,
  parseMemberSource,
} from '../lib/config.ts'
import * as Git from '../lib/git.ts'
import { Store, StoreLayer } from '../lib/store.ts'

// =============================================================================
// CLI Context Services
// =============================================================================

/** Current working directory service */
export class Cwd extends Context.Tag('megarepo/Cwd')<Cwd, string>() {
  static live = Layer.effect(
    Cwd,
    Effect.sync(() => process.cwd()),
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
    const pathService = yield* Path.Path

    // Check if already in a git repo
    const isGit = yield* Git.isGitRepo(cwd)
    if (!isGit) {
      if (json) {
        console.log(JSON.stringify({ error: 'not_git_repo', message: 'Not a git repository' }))
      } else {
        yield* Effect.logError(`${styled.red(symbols.cross)} Not a git repository. Run 'git init' first.`)
      }
      return yield* Effect.fail(new Error('Not a git repository'))
    }

    const configPath = pathService.join(cwd, CONFIG_FILE_NAME)

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
      $schema: 'https://raw.githubusercontent.com/overengineeringstudio/megarepo/main/schema/megarepo.schema.json',
      members: {},
    }

    const configContent = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(initialConfig)
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
const findMegarepoRoot = (startPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path

    let current = startPath
    while (current !== '/') {
      const configPath = pathService.join(current, CONFIG_FILE_NAME)
      const exists = yield* fs.exists(configPath)
      if (exists) {
        return Option.some(current)
      }
      current = pathService.dirname(current)
    }

    // Check root as well
    const rootConfigPath = pathService.join('/', CONFIG_FILE_NAME)
    const rootExists = yield* fs.exists(rootConfigPath)
    if (rootExists) {
      return Option.some('/')
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
      const pathService = yield* Path.Path
      const configPath = pathService.join(envRoot, CONFIG_FILE_NAME)
      const exists = yield* fs.exists(configPath)

      if (exists) {
        const name = yield* Git.deriveMegarepoName(envRoot)
        if (json) {
          console.log(JSON.stringify({ root: envRoot, name, source: 'env' }))
        } else {
          console.log(envRoot)
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
      const pathService = yield* Path.Path
      const configPath = pathService.join(root.value, CONFIG_FILE_NAME)
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
    const pathService = yield* Path.Path
    const configPath = pathService.join(root.value, CONFIG_FILE_NAME)
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
        const memberPath = pathService.join(root.value, memberName)
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
    const pathService = yield* Path.Path
    const configPath = pathService.join(root.value, CONFIG_FILE_NAME)
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
  megarepoRoot: string,
  dryRun: boolean,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const pathService = yield* Path.Path
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
      const memberPath = pathService.join(megarepoRoot, name)
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
    const storePath = yield* store.getRepoPath(source)
    const storeExists = yield* store.hasRepo(source)

    // Clone to store if needed
    if (!storeExists) {
      if (!dryRun) {
        // Ensure parent directories exist
        const parentDir = pathService.dirname(storePath)
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
      const memberPath = pathService.join(megarepoRoot, name)
      const memberExists = yield* fs.exists(memberPath)

      if (memberExists) {
        // Check if it's already a worktree
        const isGitWorktree = yield* fs.exists(pathService.join(memberPath, '.git')).pipe(
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
    const memberPath = pathService.join(megarepoRoot, name)
    const linkExists = yield* fs.exists(memberPath)

    if (linkExists) {
      // Check if it's a symlink pointing to the right place
      const stat = yield* fs.stat(memberPath).pipe(Effect.catchAll(() => Effect.succeed(null)))
      if (stat?.type === 'SymbolicLink') {
        // Symlink exists - check if it points to correct location
        const target = yield* fs.readLink(memberPath)
        if (target === storePath) {
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
      const pathService = yield* Path.Path
      const configPath = pathService.join(root.value, CONFIG_FILE_NAME)
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
          const memberPath = pathService.join(root.value, name)
          const nestedConfigPath = pathService.join(memberPath, CONFIG_FILE_NAME)
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
          yield* Effect.log(styled.dim(`Would sync ${syncedCount} members, ${alreadyCount} already synced`))
        } else {
          yield* Effect.log(styled.dim(`Synced ${syncedCount} members, ${alreadyCount} already synced`))
        }

        if (errorCount > 0) {
          yield* Effect.log(styled.red(`${errorCount} errors`))
        }

        // Show hint about nested megarepos
        if (nestedMegarepos.length > 0 && !deep) {
          yield* Effect.log('')
          yield* Effect.log(
            styled.dim(`Note: ${nestedMegarepos.length} member(s) contain nested megarepos (${nestedMegarepos.join(', ')})`),
          )
          yield* Effect.log(styled.dim(`      Run 'mr sync --deep' to sync them, or 'cd <member> && mr sync'`))
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
// Main CLI
// =============================================================================

/** Root CLI command */
const mrCommand = Cli.Command.make('mr', {}).pipe(
  Cli.Command.withSubcommands([initCommand, rootCommand, envCommand, statusCommand, lsCommand, syncCommand]),
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: '0.1.0',
})(process.argv).pipe(Effect.provide(Cwd.live))
