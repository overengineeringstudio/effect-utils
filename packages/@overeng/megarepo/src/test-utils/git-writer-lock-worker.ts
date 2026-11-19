import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect, Exit } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath } from '@overeng/effect-path'

import { consumePoolReservation, withPoolSlotOperation } from '../store/store-pool-state.ts'
import { withGitWriterLock, withPoolWorktreeOperationLock } from '../store/git-writer-lock.ts'

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
  if (mode === 'pool-ledger') {
    const [storeBasePath, , id] = process.argv.slice(6)
    if (storeBasePath === undefined || id === undefined)
      return yield* Effect.die('Expected pool store and slot UUID')
    yield* withPoolSlotOperation({
      base: EffectPath.unsafe.absoluteDir(storeBasePath), select: id,
      use: (state, save, slot) => Effect.gen(function* () {
        const preparing = yield* consumePoolReservation({
          slot, id, reservation: slot.reservation!, generation: slot.generation,
          bare: slot.bare, commit: slot.commit, charge: slot.charge,
        })
        yield* save({ ...state, slots: state.slots.map((item) => item.id === id ? preparing : item) })
        yield* body
      }),
    })
  } else if (mode === 'pool-operation') {
    const [storeBasePath, barePath, id] = process.argv.slice(6)
    if (storeBasePath === undefined || barePath === undefined || id === undefined)
      return yield* Effect.die('Expected pool store, bare repository, and slot UUID')
    yield* body.pipe(withPoolWorktreeOperationLock({ storeBasePath, barePath, id, path: repoPath }))
  } else {
    yield* mode === 'primitive' || mode === 'clone'
      ? body.pipe(withGitWriterLock({ path: repoPath, create: mode === 'clone' }))
      : body
  }
})

program.pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain({
    teardown: (exit, onExit) => {
      onExit(Exit.isSuccess(exit) === true ? Number(process.exitCode ?? 0) : 1)
    },
  }),
)
