import * as fsSync from 'node:fs'
import * as path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { Effect, FileSystem, Option } from 'effect'

import { runWatchCycle } from './mod.tsx'

const template = `export default {
  data: { name: 'genie-watch-cycle-probe', private: true },
  stringify: () => JSON.stringify({ name: 'genie-watch-cycle-probe', private: true }, null, 2),
}`

/**
 * Probe for `watch-cycle.unit.test.ts`: exercises one coalesced watch cycle
 * against a real temp workspace and prints the observed summary + TUI actions
 * as whitespace-separated lines. Run under bun — genie's template loader
 * requires the Bun global, which vitest workers do not provide.
 */
const prog = Effect.scoped(
  Effect.gen(function* () {
    const root = process.argv[2]
    if (root === undefined || !fsSync.existsSync(root)) {
      throw new Error(`usage: bun watch-cycle.probe.ts <existing-root>`)
    }
    const fs = yield* FileSystem.FileSystem

    yield* fs.writeFileString(path.join(root, 'package.json.genie.ts'), template)
    yield* fs.makeDirectory(path.join(root, 'members'), { recursive: true })
    yield* fs.writeFileString(path.join(root, 'members', 'package.json.genie.ts'), template)

    const actions: Array<{
      readonly _tag: string
      readonly path?: string
      readonly status?: string
    }> = []
    const summary = yield* runWatchCycle({
      changedPaths: [path.join(root, 'members', 'package.json.genie.ts')],
      cwd: root,
      readOnly: false,
      oxfmtConfigPath: Option.none(),
      tui: {
        dispatch: (action) => {
          if (action._tag === 'FileCompleted') {
            actions.push({ _tag: action._tag, path: action.path, status: action.status })
          } else if (action._tag === 'FileStarted') {
            actions.push({ _tag: action._tag, path: action.path })
          } else {
            actions.push({ _tag: action._tag })
          }
        },
      },
    })

    yield* Effect.sync(() => {
      // Line protocol instead of ad-hoc JSON serialization: each record is one
      // line, parsed by watch-cycle.unit.test.ts.
      process.stdout.write(
        `SUMMARY ${summary.created} ${summary.updated} ${summary.unchanged} ${summary.skipped} ${summary.failed}\n`,
      )
      for (const action of actions) {
        const pathPart = action.path === undefined ? '' : ` path=${action.path}`
        const statusPart = action.status === undefined ? '' : ` status=${action.status}`
        process.stdout.write(`ACTION ${action._tag}${pathPart}${statusPart}\n`)
      }
    })
  }).pipe(Effect.provide(NodeServices.layer)),
)

await Effect.runPromiseExit(prog).then((exit) => {
  if (exit._tag === 'Failure') {
    process.stderr.write('probe failed\n')
    process.exitCode = 1
  }
})
