import { Effect } from 'effect'

import type { Sync } from '@overeng/scg-protocol'

import { DiscordError, type AuthorityClient, type DiscordSigner } from './signer.ts'
import type { DiscordStore } from './store.ts'

export interface SyncAuthorityClient extends AuthorityClient {
  readonly sync: (cursor: number) => Effect.Effect<Sync, DiscordError>
}

/** Cursor advances only after every visible terminal edit succeeds. Delivery failure never signs a deny. */
export const syncDiscordSurface = Effect.fn('scg.discord.sync')(function* (
  signer: DiscordSigner,
  store: DiscordStore,
  authority: SyncAuthorityClient,
  channelId: string,
) {
  const snapshot = yield* Effect.try({
    try: () => ({ cursor: store.cursor(), jobs: store.jobs() }),
    catch: (cause) => new DiscordError({ operation: 'read-sync-state', cause }),
  })
  for (const job of snapshot.jobs) yield* signer.submit(job)
  const updates = yield* authority.sync(snapshot.cursor)
  for (const record of updates.pending) yield* signer.publish(record, channelId)
  const cards = yield* Effect.try({
    try: () => store.cards(),
    catch: (cause) => new DiscordError({ operation: 'load-cards', cause }),
  })
  for (const terminal of updates.terminal) {
    const card = cards.find((item) => item.record.payload.executionId === terminal.executionId)
    if (card !== undefined)
      yield* signer.close(card, yield* authority.status(terminal.executionId), true)
  }
  yield* Effect.try({
    try: () => {
      store.advance(updates.cursor)
      store.prune(Date.now())
    },
    catch: (cause) => new DiscordError({ operation: 'commit-sync-state', cause }),
  })
})
