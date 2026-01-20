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

import { CONFIG_FILE_NAME, ENV_VARS, MegarepoConfig } from '../lib/config.ts'
import * as Git from '../lib/git.ts'

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
// Main CLI
// =============================================================================

/** Root CLI command */
const mrCommand = Cli.Command.make('mr', {}).pipe(
  Cli.Command.withSubcommands([initCommand, rootCommand, envCommand, statusCommand, lsCommand]),
)

/** Exported CLI for external use */
export const cli = Cli.Command.run(mrCommand, {
  name: 'mr',
  version: '0.1.0',
})(process.argv).pipe(Effect.provide(Cwd.live))
