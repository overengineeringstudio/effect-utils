/**
 * Ls Command
 *
 * List all members in the megarepo.
 */

import * as Cli from '@effect/cli'
import { FileSystem, type Error as PlatformError } from '@effect/platform'
import { Effect, Option, type ParseResult, Schema } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, getMemberPath, MegarepoConfig } from '../../lib/config.ts'
import * as Git from '../../lib/git.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import { LsApp, LsView } from '../renderers/LsOutput/mod.ts'
import type { MemberInfo } from '../renderers/LsOutput/schema.ts'

/**
 * Recursively scan members and build flat list with owner info.
 */
const scanMembersRecursive = ({
  megarepoRoot,
  ownerPath = undefined,
  visited = new Set<string>(),
  all,
}: {
  megarepoRoot: AbsoluteDirPath
  /** Path to owning megarepo (undefined = root megarepo) */
  ownerPath?: readonly [string, ...string[]]
  visited?: Set<string>
  all: boolean
}): Effect.Effect<
  MemberInfo[],
  PlatformError.PlatformError | ParseResult.ParseError,
  FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    // Prevent cycles
    const normalizedRoot = megarepoRoot.replace(/\/$/, '')
    if (visited.has(normalizedRoot) === true) {
      return []
    }
    visited.add(normalizedRoot)

    // Load config
    const configPath = EffectPath.ops.join(
      megarepoRoot,
      EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
    )
    const configExists = yield* fs.exists(configPath)
    if (configExists === false) {
      return []
    }

    const configContent = yield* fs.readFileString(configPath)
    const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(configContent)

    const members: MemberInfo[] = []

    for (const [memberName, sourceString] of Object.entries(config.members)) {
      const memberPath = getMemberPath({ megarepoRoot, name: memberName })
      const memberExists = yield* fs.exists(memberPath)

      // Check if this member is itself a megarepo
      const nestedConfigPath = EffectPath.ops.join(
        memberPath,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )
      const isMegarepo = memberExists === true
        ? yield* fs.exists(nestedConfigPath).pipe(Effect.catchAll(() => Effect.succeed(false)))
        : false

      members.push({
        name: memberName,
        source: sourceString,
        owner: ownerPath === undefined ? { _tag: 'Root' } : { _tag: 'Nested', path: ownerPath },
        isMegarepo,
      })

      // Recursively scan nested megarepos if --all is used
      if (all === true && isMegarepo === true && memberExists === true) {
        const nestedRoot = EffectPath.unsafe.absoluteDir(
          memberPath.endsWith('/') === true ? memberPath : `${memberPath}/`,
        )
        const nestedOwnerPath: [string, ...string[]] =
          ownerPath === undefined ? [memberName] : [...ownerPath, memberName]
        const nestedMembers = yield* scanMembersRecursive({
          megarepoRoot: nestedRoot,
          ownerPath: nestedOwnerPath,
          visited,
          all,
        })
        members.push(...nestedMembers)
      }
    }

    return members
  })

/** List members */
export const lsCommand = Cli.Command.make(
  'ls',
  {
    output: outputOption,
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Recursively list members from nested megarepos'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ output, all }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const root = yield* findMegarepoRoot(cwd)

      // Run TuiApp for all output (handles JSON/TTY modes automatically)
      yield* run(
        LsApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(root) === true) {
              // Dispatch error state
              tui.dispatch({
                _tag: 'SetError',
                error: 'not_found',
                message: 'No megarepo.json found',
              })
              return
            }

            // Get megarepo name
            const megarepoName = yield* Git.deriveMegarepoName(root.value)

            // Scan members (recursively if --all)
            const members = yield* scanMembersRecursive({
              megarepoRoot: root.value,
              all,
            })

            tui.dispatch({ _tag: 'SetMembers', members, all, megarepoName })
          }),
        { view: React.createElement(LsView, { stateAtom: LsApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/ls')),
).pipe(Cli.Command.withDescription('List all members in the megarepo'))
