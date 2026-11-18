import { Database } from 'bun:sqlite'
import {
  closeSync,
  constants,
  lstatSync,
  openSync,
  realpathSync,
  unlinkSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import { createConnection } from 'node:net'
import { dirname } from 'node:path'

import { Effect, FileSystem } from 'effect'

import { makeInteractionHttpHandler } from './http.ts'
import { DiscordError, type DiscordSigner } from './signer.ts'

const absent = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT'

/** Persistent lock inode: SQLite's OS lock is released even when the process is SIGKILLed. */
const acquireSocketOwnership = (socketPath: string): Database => {
  const uid = process.getuid?.()
  const parent = dirname(socketPath)
  const directory = lstatSync(parent)
  if (
    uid === undefined ||
    !directory.isDirectory() ||
    directory.uid !== uid ||
    (directory.mode & 0o022) !== 0 ||
    realpathSync(parent) !== parent
  )
    throw new Error('Socket parent must be a canonical, owned, non-writable private directory')
  const lockPath = `${socketPath}.lifecycle.sqlite`
  try {
    closeSync(openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600))
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause
  }
  const lock = lstatSync(lockPath)
  if (!lock.isFile() || lock.uid !== uid || lock.nlink !== 1 || (lock.mode & 0o077) !== 0)
    throw new Error('Socket lifecycle lock must be an owned private regular file')
  const database = new Database(lockPath, { create: false, readwrite: true, strict: true })
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;')
    return database
  } catch (cause) {
    database.close()
    throw cause
  }
}

/** Called only while holding the lifecycle lock; no cooperating listener can replace this inode. */
const reclaimStaleSocket = async (socketPath: string): Promise<void> => {
  let previous: ReturnType<typeof lstatSync>
  try {
    previous = lstatSync(socketPath)
  } catch (cause) {
    if (absent(cause)) return
    throw cause
  }
  if (!previous.isSocket() || previous.uid !== process.getuid?.() || previous.nlink !== 1)
    throw new Error('Refusing to reclaim an unowned or non-socket ingress path')
  await new Promise<void>((resolve, reject) => {
    const probe = createConnection(socketPath)
    probe.setTimeout(1_000, () => {
      probe.destroy()
      reject(new Error('Cannot prove ingress socket is stale'))
    })
    probe.once('connect', () => {
      probe.destroy()
      reject(new Error('Ingress socket has a live listener'))
    })
    probe.once('error', (cause: NodeJS.ErrnoException) => {
      probe.destroy()
      if (cause.code === 'ECONNREFUSED') resolve()
      else reject(cause)
    })
  })
  const current = lstatSync(socketPath)
  if (
    !current.isSocket() || current.uid !== previous.uid ||
    current.dev !== previous.dev || current.ino !== previous.ino
  )
    throw new Error('Ingress socket changed during stale verification')
  unlinkSync(socketPath)
}

/** The public API proxies raw POSTs here. The host provisions a private owned parent directory. */
export const listenDiscordInteractions = Effect.fn('scg.discord.listen')(function* (options: {
  readonly socketPath: string
  readonly signer: DiscordSigner
  readonly onFailure: (cause: unknown) => void
}) {
  if (!options.socketPath.startsWith('/'))
    return yield* new DiscordError({ operation: 'socket-path', cause: 'Expected an absolute private socket path' })
  const fs = yield* FileSystem.FileSystem
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => acquireSocketOwnership(options.socketPath),
      catch: (cause) => new DiscordError({ operation: 'socket-ownership', cause }),
    }),
    (database) => Effect.sync(() => database.close()),
  )
  yield* options.signer.recover()
  yield* Effect.tryPromise({
    try: () => reclaimStaleSocket(options.socketPath),
    catch: (cause) => new DiscordError({ operation: 'socket-recovery', cause }),
  })
  const handler = makeInteractionHttpHandler(options.signer, options.onFailure)
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => {
        const { promise, resolve, reject } = Promise.withResolvers<Server>()
        const instance = createServer((request, response) => {
          if (request.url !== '/interactions') {
            response.writeHead(404).end()
            return
          }
          handler(request, response)
        })
        instance.once('error', reject)
        instance.listen(options.socketPath, () => {
          instance.off('error', reject)
          resolve(instance)
        })
        return promise
      },
      catch: (cause) => new DiscordError({ operation: 'listen', cause }),
    }),
    (instance) =>
      Effect.promise(() => {
        const { promise, resolve } = Promise.withResolvers<void>()
        instance.close(() => resolve())
        instance.closeAllConnections()
        return promise
      }),
  )
  yield* fs.chmod(options.socketPath, 0o660)
  return server
})
