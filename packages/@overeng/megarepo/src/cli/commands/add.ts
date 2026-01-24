/**
 * Add Command
 *
 * Adds a new member repository to the megarepo configuration.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'

import { styled, symbols } from '@overeng/cli-ui'
import { EffectPath } from '@overeng/effect-path'

import { CONFIG_FILE_NAME, MegarepoConfig, parseSourceString } from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { StoreLayer } from '../../lib/store.ts'
import { syncMember } from '../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'

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
export const addCommand = Cli.Command.make(
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
          console.log(
            JSON.stringify({
              error: 'not_found',
              message: 'No megarepo.json found',
            }),
          )
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
            JSON.stringify({
              error: 'invalid_repo',
              message: `Invalid repo reference: ${repo}`,
            }),
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
          JSON.stringify({
            status: 'added',
            member: memberName,
            source: parsed.sourceString,
          }),
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
