import type { IncomingMessage, ServerResponse } from 'node:http'

import { Effect } from 'effect'

import type { DiscordSigner } from './signer.ts'

/** Mount only on the configured interaction URL. No body parser may run before signature verification. */
export const makeInteractionHttpHandler =
  (
    signer: DiscordSigner,
    onFailure: (cause: unknown) => void,
  ): ((request: IncomingMessage, response: ServerResponse) => void) =>
  (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end()
      return
    }
    const startedAt = performance.now()
    const chunks: Uint8Array[] = []
    let size = 0
    let finished = false
    // Leave 500ms of the platform's 3s budget for the response path. Slow bodies fail closed.
    const deadline = setTimeout(() => {
      finished = true
      response.writeHead(408).end()
      request.destroy()
    }, 2500)
    const fail = (status: number) => {
      clearTimeout(deadline)
      finished = true
      if (!response.headersSent) response.writeHead(status).end()
    }
    request.on('error', () => fail(400))
    request.on('data', (chunk: Buffer) => {
      size += chunk.byteLength
      if (size > 65_536) {
        fail(413)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (finished) return
      if (performance.now() - startedAt >= 2500) {
        fail(408)
        return
      }
      const signature = request.headers['x-signature-ed25519']
      const timestamp = request.headers['x-signature-timestamp']
      if (typeof signature !== 'string' || typeof timestamp !== 'string') {
        fail(401)
        return
      }
      void Effect.runPromise(
        signer.handle({
          body: Buffer.concat(chunks),
          signature,
          timestamp,
          nowMs: Date.now(),
          acknowledge: (status, body) => {
            if (finished) return false
            if (performance.now() - startedAt >= 2500) {
              fail(408)
              return false
            }
            clearTimeout(deadline)
            finished = true
            response
              .writeHead(status, { 'content-type': 'application/json' })
              .end(JSON.stringify(body))
            return true
          },
        }),
      ).catch((cause: unknown) => {
        if (!finished) fail(401)
        onFailure(cause)
      })
    })
  }
