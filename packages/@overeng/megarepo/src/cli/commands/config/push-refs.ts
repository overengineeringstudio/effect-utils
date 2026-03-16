/**
 * `mr config push-refs` — Propagate member refs from parent to nested megarepos
 *
 * For each nested megarepo (members that contain a megarepo.json),
 * updates shared member refs to match the parent's config.
 * Matching is done by canonical URL (org/repo), not by member name.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import {
  CONFIG_FILE_NAME,
  getBaseSourceString,
  getMemberPath,
  MegarepoConfig,
  parseSourceString,
} from '../../../lib/config.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../../context.ts'
import { NotInMegarepoError } from '../../errors.ts'
import { PushRefsApp, PushRefsView } from '../../renderers/PushRefsOutput/mod.ts'

// =============================================================================
// Types
// =============================================================================

interface RefUpdate {
  readonly nestedMember: string
  readonly sharedMemberName: string
  readonly oldSource: string
  readonly newSource: string
}

interface NestedResult {
  readonly name: string
  readonly updates: ReadonlyArray<RefUpdate>
  readonly hasGenie: boolean
}

// =============================================================================
// Core Logic
// =============================================================================

/** Build a URL key for matching members across megarepos (normalized org/repo without ref) */
const getMemberUrlKey = (sourceString: string): string | undefined => {
  const source = parseSourceString(getBaseSourceString(sourceString))
  if (source === undefined) return undefined
  switch (source.type) {
    case 'github':
      return `${source.owner}/${source.repo}`.toLowerCase()
    case 'url':
      return source.url.toLowerCase().replace(/\.git$/, '')
    case 'path':
      return undefined
  }
}

/** Propagate refs from parent config to a single nested megarepo */
const pushRefsToNested = Effect.fn('megarepo/config/push-refs/nested')(
  (options: {
    nestedName: string
    nestedRoot: AbsoluteDirPath
    parentMembers: Record<string, string>
    dryRun: boolean
    only: Option.Option<string>
  }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const configPath = EffectPath.ops.join(
        options.nestedRoot,
        EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
      )

      const configExists = yield* fs.exists(configPath)
      if (configExists === false) return undefined

      const configContent = yield* fs.readFileString(configPath)
      const nestedConfig = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
        configContent,
      )

      // Build parent URL → source string lookup
      const parentUrlMap = new Map<string, string>()
      for (const [, sourceString] of Object.entries(options.parentMembers)) {
        const key = getMemberUrlKey(sourceString)
        if (key !== undefined) {
          parentUrlMap.set(key, sourceString)
        }
      }

      // Parse --only filter
      const onlyMembers = Option.map(
        options.only,
        (s) => new Set(s.split(',').map((m) => m.trim())),
      )

      // Find shared members and compute updates
      const updates: RefUpdate[] = []
      const updatedMembers = { ...nestedConfig.members }

      for (const [nestedMemberName, nestedSourceString] of Object.entries(nestedConfig.members)) {
        // Apply --only filter
        if (
          Option.isSome(onlyMembers) === true &&
          onlyMembers.value.has(nestedMemberName) === false
        )
          continue

        const nestedUrlKey = getMemberUrlKey(nestedSourceString)
        if (nestedUrlKey === undefined) continue

        const parentSourceString = parentUrlMap.get(nestedUrlKey)
        if (parentSourceString === undefined) continue

        // Same URL — check if ref differs
        if (nestedSourceString === parentSourceString) continue

        updates.push({
          nestedMember: options.nestedName,
          sharedMemberName: nestedMemberName,
          oldSource: nestedSourceString,
          newSource: parentSourceString,
        })
        updatedMembers[nestedMemberName] = parentSourceString
      }

      if (updates.length === 0) return undefined

      // Write updated config (unless dry-run)
      if (options.dryRun === false) {
        const updatedConfig = { ...nestedConfig, members: updatedMembers }
        const encoded = yield* Schema.encode(Schema.parseJson(MegarepoConfig, { space: 2 }))(
          updatedConfig,
        )
        yield* fs.writeFileString(configPath, encoded + '\n')
      }

      // Check for genie file
      const geniePath = EffectPath.ops.join(
        options.nestedRoot,
        EffectPath.unsafe.relativeFile(`${CONFIG_FILE_NAME}.genie.ts`),
      )
      const hasGenie = yield* fs.exists(geniePath)

      return { name: options.nestedName, updates, hasGenie } satisfies NestedResult
    }),
)

// =============================================================================
// CLI Command
// =============================================================================

/** CLI command to propagate member refs from the parent megarepo to nested megarepo configs */
export const pushRefsCommand = Cli.Command.make(
  'push-refs',
  {
    output: outputOption,
    dryRun: Cli.Options.boolean('dry-run').pipe(
      Cli.Options.withDescription('Show what would change without writing files'),
      Cli.Options.withDefault(false),
    ),
    all: Cli.Options.boolean('all').pipe(
      Cli.Options.withDescription('Recursively push refs to nested-of-nested megarepos'),
      Cli.Options.withDefault(false),
    ),
    only: Cli.Options.text('only').pipe(
      Cli.Options.withDescription('Only push refs for these shared members (comma-separated)'),
      Cli.Options.optional,
    ),
  },
  ({ output, dryRun, all, only }) =>
    run(
      PushRefsApp,
      (tui) =>
        Effect.gen(function* () {
          const cwd = yield* Cwd
          const root = yield* findMegarepoRoot(cwd)

          if (Option.isNone(root) === true) {
            tui.dispatch({
              _tag: 'SetError',
              error: 'not_in_megarepo',
              message: 'Not in a megarepo',
            })
            return yield* new NotInMegarepoError({ message: 'Not in a megarepo' })
          }

          tui.dispatch({ _tag: 'SetScanning' })

          const megarepoRoot = root.value
          const fs = yield* FileSystem.FileSystem

          // Load parent config
          const configPath = EffectPath.ops.join(
            megarepoRoot,
            EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
          )
          const configContent = yield* fs.readFileString(configPath)
          const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
            configContent,
          )

          // Find nested megarepos and push refs
          const processLevel = (options: {
            levelRoot: AbsoluteDirPath
            levelMembers: Record<string, string>
          }): Effect.Effect<ReadonlyArray<NestedResult>, Error, FileSystem.FileSystem> =>
            Effect.gen(function* () {
              const results: NestedResult[] = []

              for (const memberName of Object.keys(options.levelMembers)) {
                const memberPath = getMemberPath({
                  megarepoRoot: options.levelRoot,
                  name: memberName,
                })
                const nestedConfigPath = EffectPath.ops.join(
                  memberPath,
                  EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
                )
                const hasNestedConfig = yield* fs.exists(nestedConfigPath)
                if (hasNestedConfig === false) continue

                const result = yield* pushRefsToNested({
                  nestedName: memberName,
                  nestedRoot: memberPath,
                  parentMembers: options.levelMembers,
                  dryRun,
                  only,
                })

                if (result !== undefined) {
                  results.push(result)
                }

                // Recurse into nested megarepos if --all
                if (all === true) {
                  const nestedContent = yield* fs.readFileString(nestedConfigPath)
                  const nestedConfig = yield* Schema.decodeUnknown(
                    Schema.parseJson(MegarepoConfig),
                  )(nestedContent)
                  const nestedResults = yield* processLevel({
                    levelRoot: memberPath,
                    levelMembers: nestedConfig.members,
                  })
                  results.push(...nestedResults)
                }
              }

              return results
            })

          const results = yield* processLevel({
            levelRoot: megarepoRoot,
            levelMembers: config.members,
          })

          if (results.length === 0) {
            tui.dispatch({ _tag: 'SetAligned' })
          } else {
            const totalUpdates = results.reduce((sum, r) => sum + r.updates.length, 0)
            tui.dispatch({
              _tag: 'SetResult',
              results: results.map((r) => ({
                name: r.name,
                updates: [...r.updates],
                hasGenie: r.hasGenie,
              })),
              totalUpdates,
              dryRun,
            })
          }
        }),
      { view: React.createElement(PushRefsView, { stateAtom: PushRefsApp.stateAtom }) },
    ).pipe(Effect.provide(outputModeLayer(output)), Effect.withSpan('megarepo/config/push-refs')),
).pipe(
  Cli.Command.withDescription(
    'Propagate member refs from this megarepo to nested megarepo configs',
  ),
)
