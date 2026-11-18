import { createServer, type Server } from 'node:http'

import { Effect, FileSystem } from 'effect'

import { makeInteractionHttpHandler } from './http.ts'
import { DiscordError, type DiscordSigner } from './signer.ts'

/** The public API proxies raw POSTs here. Parent directory and socket group are provisioned by the host. */
export const listenDiscordInteractions = Effect.fn('scg.discord.listen')(function* (options: {
  readonly socketPath: string
  readonly signer: DiscordSigner
  readonly onFailure: (cause: unknown) => void
}) {
  if (!options.socketPath.startsWith('/'))
    return yield* new DiscordError({
      operation: 'socket-path',
      cause: 'Expected an absolute private socket path',
    })
  const fs = yield* FileSystem.FileSystem
  yield* options.signer.recover()
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
