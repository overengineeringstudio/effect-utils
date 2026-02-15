/**
 * Add Command
 *
 * Adds a new member repository to the megarepo configuration.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, MegarepoConfig, parseSourceString } from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { StoreLayer } from '../../lib/store.ts'
import { syncMember } from '../../lib/sync/mod.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import { AddCommandError } from '../errors.ts'
import { AddApp, AddView } from '../renderers/AddOutput/mod.ts'

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
      suggestedName = Option.isSome(parsed) === true ? parsed.value.repo : 'unknown'
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
      Cli.Options.withDefault(true),
    ),
    output: outputOption,
  },
  ({ repo, name, sync, output }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      yield* run(
        AddApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(root) === true) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_in_megarepo',
                message: 'No megarepo.json found',
              })
              return yield* new AddCommandError({ message: 'Not in a megarepo' })
            }

            // Parse the repo reference
            const parsed = parseRepoRef(repo)
            if (parsed === undefined) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'invalid_repo',
                message: `Invalid repo reference: ${repo}`,
              })
              return yield* new AddCommandError({ message: 'Invalid repo reference' })
            }

            const memberName = Option.getOrElse(name, () => parsed.suggestedName)

            // Load current config
            const fs = yield* FileSystem.FileSystem
            const configPath = EffectPath.ops.join(
              root.value,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
            )
            const configContent = yield* fs.readFileString(configPath)
            const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
              configContent,
            )

            // Check if member already exists
            if (memberName in config.members) {
              tui.dispatch({
                _tag: 'SetError',
                error: 'already_exists',
                message: `Member '${memberName}' already exists`,
              })
              return yield* new AddCommandError({ message: 'Member already exists' })
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
            const newConfigContent = yield* Schema.encode(
              Schema.parseJson(MegarepoConfig, { space: 2 }),
            )(newConfig)
            yield* fs.writeFileString(configPath, newConfigContent + '\n')

            // Sync if requested
            if (sync === true) {
              tui.dispatch({
                _tag: 'SetAdding',
                member: memberName,
                source: parsed.sourceString,
              })

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

              const syncStatus =
                result.status === 'cloned'
                  ? ('cloned' as const)
                  : result.status === 'error'
                    ? ('error' as const)
                    : ('synced' as const)

              tui.dispatch({
                _tag: 'SetSuccess',
                member: memberName,
                source: parsed.sourceString,
                synced: true,
                syncStatus,
              })
            } else {
              tui.dispatch({
                _tag: 'SetSuccess',
                member: memberName,
                source: parsed.sourceString,
                synced: false,
              })
            }
          }),
        { view: React.createElement(AddView, { stateAtom: AddApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.provide(StoreLayer), Effect.withSpan('megarepo/add')),
).pipe(Cli.Command.withDescription('Add a new member repository'))
