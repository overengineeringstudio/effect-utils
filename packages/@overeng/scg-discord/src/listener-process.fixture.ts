import { generateKeyPairSync } from 'node:crypto'

import { NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'

import { listenDiscordInteractions } from './listener.ts'
import { DiscordError, makeSigner } from './signer.ts'
import { DiscordStore } from './store.ts'

const socketPath = process.argv[2]!
const keys = generateKeyPairSync('ed25519')
const unavailable = Effect.fail(new DiscordError({ operation: 'fixture-network', cause: 'No external network enrolled' }))
const store = new DiscordStore(`${socketPath}.signer.sqlite`)
const signer = makeSigner({
  applicationId: 'synthetic-app', allowedUserIds: new Set(['human']),
  discordPublicKey: keys.publicKey, authorityKeyId: 'synthetic-authority',
  authorityPublicKey: keys.publicKey, surfaceId: 'synthetic-surface',
  signerKeyId: 'synthetic-signer', signerPrivateKey: keys.privateKey, timeZone: 'UTC',
}, store, {
  pending: () => unavailable, status: () => unavailable, decide: () => unavailable,
}, {
  post: () => unavailable, edit: () => unavailable, ephemeral: () => unavailable,
})
try {
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* listenDiscordInteractions({ socketPath, signer, onFailure: () => undefined })
    process.stdout.write('READY\n')
    yield* Effect.never
  })).pipe(Effect.provide(NodeServices.layer)))
} catch {
  process.stderr.write('LISTENER_REJECTED\n')
  process.exitCode = 1
} finally {
  store.close()
}
