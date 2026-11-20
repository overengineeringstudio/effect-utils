import { Effect } from 'effect'

import type { Sync } from '@overeng/scg-protocol'

import { DiscordError, type AuthorityClient, type DiscordSigner } from './signer.ts'
import type { DiscordStore } from './store.ts'

/** Authenticated incremental authority feed paired with per-execution status reads. */
export interface SyncAuthorityClient extends AuthorityClient {
  readonly sync: (cursor: number) => Effect.Effect<Sync, DiscordError>
}

/** Cursor advances only after every visible terminal edit succeeds. Delivery failure never signs a deny. */
export const syncDiscordSurface = Effect.fn('scg.discord.sync')(function* ({
  signer,
  store,
  authority,
  channelId,
}: {
  readonly signer: DiscordSigner
  readonly store: DiscordStore
  readonly authority: SyncAuthorityClient
  readonly channelId: string
}) {
  const snapshot = yield* Effect.try({
    try: () => ({ cursor: store.cursor(), jobs: store.jobs() }),
    catch: (cause) => new DiscordError({ operation: 'read-sync-state', cause }),
  })
  for (const job of snapshot.jobs) yield* signer.submit(job)
  const updates = yield* authority.sync(snapshot.cursor)
  for (const record of updates.pending)
    yield* signer.publish({ record: record, channelId: channelId })
  const cards = yield* Effect.try({
    try: () => store.cards(),
    catch: (cause) => new DiscordError({ operation: 'load-cards', cause }),
  })
  // Reserved cards remain tracked even after their sync event/candidate is
  // consumed. Poll their durable status until the final PATCH succeeds.
  for (const card of cards)
    yield* signer.close({
      card: card,
      status: yield* authority.status(card.record.payload.executionId),
      elsewhere: true,
    })
  yield* Effect.try({
    try: () => {
      store.advance(updates.cursor)
      store.prune(Date.now())
    },
    catch: (cause) => new DiscordError({ operation: 'commit-sync-state', cause }),
  })
})
