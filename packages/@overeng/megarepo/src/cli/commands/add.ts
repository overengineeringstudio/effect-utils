/**
 * Add Command
 *
 * Adds a new member repository to the megarepo configuration.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Console, Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { renderToString } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, MegarepoConfig, parseSourceString } from '../../lib/config.ts'

class AddCommandError extends Schema.TaggedError<AddCommandError>()('AddCommandError', {
  message: Schema.String,
}) {}
import * as Git from '../../lib/git.ts'
import { StoreLayer } from '../../lib/store.ts'
import { syncMember } from '../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, jsonOption } from '../context.ts'
import { AddOutput, AddErrorOutput } from '../renderers/AddOutput.tsx'

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
          const output = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(AddErrorOutput, { error: 'not_in_megarepo' }),
            }),
          )
          yield* Console.error(output)
        }
        return yield* Effect.fail(new AddCommandError({ message: 'Not in a megarepo' }))
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
          const output = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(AddErrorOutput, { error: 'invalid_repo', repo }),
            }),
          )
          yield* Console.error(output)
        }
        return yield* Effect.fail(new AddCommandError({ message: 'Invalid repo reference' }))
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
          const output = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(AddErrorOutput, {
                error: 'already_exists',
                member: memberName,
              }),
            }),
          )
          yield* Console.error(output)
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
        const output = yield* Effect.promise(() =>
          renderToString({
            element: React.createElement(AddOutput, {
              member: memberName,
              source: parsed.sourceString,
            }),
          }),
        )
        yield* Console.log(output)
      }

      // Sync if requested
      if (sync) {
        const { Text, Box } = yield* Effect.promise(async () => import('@overeng/tui-react'))
        if (!json) {
          const syncingOutput = yield* Effect.promise(() =>
            renderToString({ element: React.createElement(Text, { dim: true }, 'Syncing...') }),
          )
          yield* Console.log(syncingOutput)
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
          // Render just the sync result line (not the full AddOutput to avoid duplicating "Added")
          const isError = result.status === 'error'
          const statusText = result.status === 'cloned' ? 'cloned' : result.status
          const output = yield* Effect.promise(() =>
            renderToString({
              element: React.createElement(
                Box,
                { flexDirection: 'row' },
                React.createElement(
                  Text,
                  { color: isError ? 'red' : 'green' },
                  isError ? '\u2717' : '\u2713',
                ),
                React.createElement(Text, null, ' '),
                React.createElement(Text, { bold: true }, memberName),
                React.createElement(Text, { dim: true }, ` (${statusText})`),
              ),
            }),
          )
          yield* Console.log(output)
        }
      }
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/add')),
).pipe(Cli.Command.withDescription('Add a new member repository'))
