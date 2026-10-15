import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { withGitWriterLock } from '../store/git-writer-lock.ts'

/** Bun subprocess fixture: filesystem handshakes coordinate real independent runtimes. */
const [mode, repoPath, marker, exitCode = '0'] = process.argv.slice(2)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  if (mode === undefined || repoPath === undefined || marker === undefined) {
    return yield* Effect.die('Expected mode, repository path, and marker prefix')
  }
  const body = Effect.gen(function* () {
    yield* fs.writeFileString(`${marker}.entered`, String(process.pid))
    yield* fs.writeFileString(`${marker}.args`, process.argv.slice(6).join('\n'))
    while ((yield* fs.exists(`${marker}.release`)) === false) {
      yield* Effect.sleep('10 millis')
    }
    yield* fs.writeFileString(`${marker}.exited`, '')
    process.exitCode = Number(exitCode)
  })
  yield* fs.writeFileString(`${marker}.attempted`, '')
  yield* mode === 'primitive' || mode === 'clone'
    ? body.pipe(withGitWriterLock(repoPath, { create: mode === 'clone' }))
    : body
})

program.pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({
    teardown: (exit, onExit) => {
      onExit(Exit.isSuccess(exit) === true ? Number(process.exitCode ?? 0) : 1)
    },
  }),
)
