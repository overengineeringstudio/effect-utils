/**
 * Deps Command
 *
 * Show the Nix input dependency graph between megarepo members.
 */

import * as Cli from '@effect/cli'
import { FileSystem } from '@effect/platform'
import { Effect, Option, Schema } from 'effect'
import React from 'react'

import { EffectPath } from '@overeng/effect-path'
import { run } from '@overeng/tui-react'

import { CONFIG_FILE_NAME, MegarepoConfig } from '../../lib/config.ts'
import { LOCK_FILE_NAME, readLockFile } from '../../lib/lock.ts'
import { buildDependencyGraph } from '../../lib/nix-lock/mod.ts'
import { Cwd, findMegarepoRoot, outputOption, outputModeLayer } from '../context.ts'
import { DepsApp, DepsView } from '../renderers/DepsOutput/mod.ts'
import type { DepsMember } from '../renderers/DepsOutput/schema.ts'

export const depsCommand = Cli.Command.make(
  'deps',
  {
    output: outputOption,
  },
  ({ output }) =>
    Effect.gen(function* () {
      const cwd = yield* Cwd
      const rootOpt = yield* findMegarepoRoot(cwd)

      yield* run(
        DepsApp,
        (tui) =>
          Effect.gen(function* () {
            if (Option.isNone(rootOpt) === true) {
              tui.dispatch({ _tag: 'SetError', message: 'No megarepo.json found' })
              return
            }
            const root = rootOpt.value
            const fs = yield* FileSystem.FileSystem

            // Load config
            const configPath = EffectPath.ops.join(
              root,
              EffectPath.unsafe.relativeFile(CONFIG_FILE_NAME),
            )
            const configContent = yield* fs.readFileString(configPath)
            const config = yield* Schema.decodeUnknown(Schema.parseJson(MegarepoConfig))(
              configContent,
            )

            // Load lock file
            const lockPath = EffectPath.ops.join(
              root,
              EffectPath.unsafe.relativeFile(LOCK_FILE_NAME),
            )
            const lockFileOpt = yield* readLockFile(lockPath)
            if (Option.isNone(lockFileOpt) === true) {
              tui.dispatch({
                _tag: 'SetError',
                message: 'Lock file required for mr deps — run `mr lock` first',
              })
              return
            }
            const lockFile = lockFileOpt.value

            // Build dependency graph
            const graph = yield* buildDependencyGraph({
              megarepoRoot: root,
              config,
              lockFile,
            })

            if (graph.size === 0) {
              tui.dispatch({ _tag: 'SetEmpty' })
              return
            }

            // Group by upstream member
            const byUpstream = new Map<string, Map<string, string[]>>()

            for (const [memberName, deps] of graph) {
              for (const input of deps.inputs) {
                let upstreamEntry = byUpstream.get(input.upstreamMember)
                if (upstreamEntry === undefined) {
                  upstreamEntry = new Map<string, string[]>()
                  byUpstream.set(input.upstreamMember, upstreamEntry)
                }
                const files = upstreamEntry.get(memberName) ?? []
                if (files.includes(input.file) === false) {
                  files.push(input.file)
                }
                upstreamEntry.set(memberName, files)
              }
            }

            const members: DepsMember[] = [...byUpstream]
              .toSorted(([a], [b]) => a.localeCompare(b))
              .map(([upstreamName, downstreams]) => ({
                name: upstreamName,
                downstreamMembers: [...downstreams]
                  .toSorted(([a], [b]) => a.localeCompare(b))
                  .map(([name, files]) => ({ name, files })),
              }))

            tui.dispatch({ _tag: 'SetDeps', members })
          }),
        { view: React.createElement(DepsView, { stateAtom: DepsApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }).pipe(Effect.withSpan('megarepo/deps')),
).pipe(Cli.Command.withDescription('Show the Nix input dependency graph between megarepo members.'))
