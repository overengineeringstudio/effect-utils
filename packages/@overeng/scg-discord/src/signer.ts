import { type KeyObject } from 'node:crypto'

import { Effect, Schema, Semaphore } from 'effect'

import {
  digest,
  signPayload,
  verifyPayload,
  type SignedDecision,
  type SignedPending,
  type Status,
} from '@overeng/scg-protocol'

import {
  renderPendingCard,
  renderClosedCard,
  renderInspectReply,
  renderWordsReply,
  type DiscordMessage,
  type CardResult,
} from './card.ts'
import { InteractionError, verifyInteraction } from './interaction.ts'
import { decisionFor, type Card, type DiscordStore, type Job } from './store.ts'

export class DiscordError extends Schema.TaggedError<DiscordError>()('DiscordError', {
  operation: Schema.String,
  cause: Schema.Defect,
}) {}
export interface AuthorityClient {
  readonly pending: (executionId: string) => Effect.Effect<SignedPending, DiscordError>
  /** Resolves only once the authority has durably accepted or reports the winning terminal state. */
  readonly decide: (decision: SignedDecision) => Effect.Effect<Status, DiscordError>
  readonly status: (executionId: string) => Effect.Effect<Status, DiscordError>
}
export interface DiscordDelivery {
  readonly post: (
    channelId: string,
    message: DiscordMessage,
  ) => Effect.Effect<{ readonly id: string; readonly channel_id: string }, DiscordError>
  readonly edit: (card: Card, message: DiscordMessage) => Effect.Effect<void, DiscordError>
  readonly ephemeral: (
    applicationId: string,
    token: string,
    message: DiscordMessage,
  ) => Effect.Effect<void, DiscordError>
}
export interface SignerConfig {
  readonly applicationId: string
  readonly allowedUserIds: ReadonlySet<string>
  readonly discordPublicKey: KeyObject
  readonly authorityKeyId: string
  readonly authorityPublicKey: KeyObject
  readonly surfaceId: string
  readonly signerKeyId: string
  readonly signerPrivateKey: KeyObject
  readonly timeZone: string
  /** Fetches from the independently authenticated origin source; text is never journaled. */
  readonly readOriginWords?: (locator: string) => Effect.Effect<string, DiscordError>
}
export interface InteractionInput {
  readonly body: Uint8Array
  readonly signature: string | undefined
  readonly timestamp: string | undefined
  readonly nowMs: number
  /** Flush/end the HTTP response; false means the deadline elapsed, so do no remote work. */
  readonly acknowledge: (status: number, body: { readonly type: number }) => boolean
}
export interface DiscordSigner {
  readonly handle: (input: InteractionInput) => Effect.Effect<void, InteractionError | DiscordError>
  readonly recover: () => Effect.Effect<void, InteractionError | DiscordError>
  readonly submit: (job: Job) => Effect.Effect<void, InteractionError | DiscordError>
  readonly close: (
    card: Card,
    status: Status,
    elsewhere: boolean,
  ) => Effect.Effect<void, InteractionError | DiscordError>
  readonly publish: (
    record: SignedPending,
    channelId: string,
  ) => Effect.Effect<void, InteractionError | DiscordError>
}
const io = <T>(operation: string, run: () => T) =>
  Effect.try({ try: run, catch: (cause) => new DiscordError({ operation, cause }) })

export const makeSigner = (
  config: SignerConfig,
  store: DiscordStore,
  authority: AuthorityClient,
  discord: DiscordDelivery,
): DiscordSigner => {
  // Status-read/render/PATCH and terminal PATCH/journal-close are one serialized
  // transition; a suspended origin read must never overwrite a terminal edit.
  const edits = Semaphore.makeUnsafe(1)
  const verified = (record: SignedPending): boolean =>
    record.keyId === config.authorityKeyId &&
    verifyPayload('pending', record, config.authorityPublicKey)
  const render = Effect.fn('scg.discord.render')(function* (card: Card) {
    let originWords
    const origin = card.record.payload.review.context?.origin
    if (
      origin !== undefined &&
      origin.surface === 'discord' &&
      origin.provenance !== 'claimed' &&
      card.record.payload.review.sensitivity === 'low' &&
      origin.wordsAvailable &&
      config.readOriginWords !== undefined
    ) {
      const text = yield* config.readOriginWords(origin.locator)
      if (digest(text) !== origin.digest) return yield* new InteractionError({ reason: 'binding' })
      originWords = { digest: origin.digest, text }
    }
    const result = renderPendingCard(
      card.record.payload,
      {
        options: Object.fromEntries(card.controls.map(({ optionId, id }) => [optionId, id])),
        inspect: card.inspectId,
        words: card.wordsId,
      },
      config,
      originWords,
    )
    if (result._tag === 'Rejected') return yield* new InteractionError({ reason: 'body' })
    return result.message
  })
  const publishUnlocked = Effect.fn('scg.discord.publish')(function* (
    record: SignedPending,
    channelId: string,
  ) {
    if (!verified(record)) return yield* new InteractionError({ reason: 'signature' })
    if (yield* io('find-publication', () => store.has(record.payload.executionId))) {
      const existing = yield* io('find-open-publication', () =>
        store
          .cards()
          .find((card) => card.record.payload.executionId === record.payload.executionId),
      )
      // A failed activation PATCH leaves an open journal entry. Retry the exact
      // durable control mapping, but never reactivate a closed or resolved review.
      if (existing !== undefined) {
        const status = yield* authority.status(record.payload.executionId)
        if (status.state === 'pending') yield* discord.edit(existing, yield* render(existing))
        else yield* closeUnlocked(existing, status, true)
      }
      return
    }
    // Never expose an enabled control before its exact mapping is durably journaled.
    const posted = yield* discord.post(channelId, {
      flags: 32768,
      allowed_mentions: { parse: [] },
      components: [{ type: 10, content: 'Authenticating review. No decision is available yet.' }],
    })
    const card = yield* io('add-card', () => store.add(record, posted.channel_id, posted.id))
    yield* discord.edit(card, yield* render(card))
  })
  const closeUnlocked = Effect.fn('scg.discord.close')(function* (
    card: Card,
    status: Status,
    elsewhere: boolean,
  ) {
    if (
      status.executionId !== card.record.payload.executionId ||
      status.requestDigest !== card.record.payload.requestDigest
    ) {
      return yield* new InteractionError({ reason: 'binding' })
    }
    if (status.state === 'pending') return
    const rendered = renderClosedCard(
      card.record.payload,
      { _tag: 'Resolved', state: status.state, decidedElsewhere: elsewhere },
      config,
    )
    if (rendered._tag === 'Rejected') return yield* new InteractionError({ reason: 'body' })
    yield* discord.edit(card, rendered.message)
    // Mark closed only after the PATCH succeeds; restart retries failed edits.
    yield* io('close-card', () => store.closed(card.record.payload.executionId))
  })
  const publish: DiscordSigner['publish'] = (record, channelId) =>
    publishUnlocked(record, channelId).pipe(Semaphore.withPermits(edits, 1))
  const close: DiscordSigner['close'] = (card, status, elsewhere) =>
    closeUnlocked(card, status, elsewhere).pipe(Semaphore.withPermits(edits, 1))
  const submit = Effect.fn('scg.discord.submit')(function* (job: Job) {
    if (!verified(job.card.record)) return yield* new InteractionError({ reason: 'signature' })
    const candidate = signPayload(
      'decision',
      job.decision,
      config.signerKeyId,
      config.signerPrivateKey,
    )
    const previous = yield* authority.status(job.card.record.payload.executionId)
    const status = previous.state === 'pending' ? yield* authority.decide(candidate) : previous
    if (status.state === 'pending') return yield* new InteractionError({ reason: 'unavailable' })
    yield* close(job.card, status, status.decisionDigest !== digest(candidate))
    yield* io('complete-job', () => store.complete(job.interactionId))
  })
  const handle = Effect.fn('scg.discord.handle')(function* (input: InteractionInput) {
    const interaction = yield* verifyInteraction({
      ...input,
      publicKey: config.discordPublicKey,
      applicationId: config.applicationId,
      allowedUserIds: config.allowedUserIds,
    })
    if (interaction.type === 1) {
      input.acknowledge(200, { type: 1 })
      return
    }
    const message = interaction.message
    const customId = interaction.data?.custom_id
    if (message === undefined || customId === undefined)
      return yield* new InteractionError({ reason: 'binding' })
    const card = yield* io('find-card', () => store.find(message.id, message.channel_id))
    if (card === undefined || !verified(card.record))
      return yield* new InteractionError({ reason: 'binding' })
    const selected = card.controls.find(({ id }) => id === customId)
    const inspect = card.inspectId === customId
    const words = card.wordsId === customId
    if (selected === undefined && !inspect && !words)
      return yield* new InteractionError({ reason: 'binding' })
    if (card.record.payload.expiresAt <= input.nowMs)
      return yield* new InteractionError({ reason: 'timestamp' })
    const principalId = interaction.member?.user.id ?? interaction.user?.id
    if (principalId === undefined) return yield* new InteractionError({ reason: 'user' })
    const option = card.record.payload.options.find(
      ({ optionId }) => optionId === selected?.optionId,
    )
    if (
      !inspect &&
      !words &&
      (option === undefined ||
        option.kind === 'session-rule' ||
        (card.record.payload.review.sensitivity === 'sensitive' &&
          (option.kind === 'similar-lease' || option.kind === 'grant-to-parent')))
    ) {
      return yield* new InteractionError({ reason: 'binding' })
    }
    const job =
      option === undefined
        ? undefined
        : {
            interactionId: interaction.id,
            card,
            decision: decisionFor(
              card,
              option.optionId,
              principalId,
              config.surfaceId,
              input.nowMs,
            ),
          }
    if (
      !(yield* io('claim-interaction', () =>
        store.claim(interaction.id, Number(input.timestamp) * 1000, job),
      ))
    ) {
      return yield* new InteractionError({ reason: 'replay' })
    }
    if (!input.acknowledge(200, { type: 6 }))
      return yield* new InteractionError({ reason: 'timestamp' })
    if (job !== undefined) yield* io('acknowledge-job', () => store.acknowledged(interaction.id))
    // All remote I/O occurs after the deferred-update ACK; receipt, never the click, closes the card.
    const current = yield* authority.pending(card.record.payload.executionId)
    if (!verified(current) || digest(current.payload) !== digest(card.record.payload)) {
      yield* io('discard-invalid-candidate', () => store.complete(interaction.id))
      return yield* new InteractionError({ reason: 'binding' })
    }
    if (inspect || words) {
      let reply: CardResult
      if (words) {
        const origin = current.payload.review.context?.origin
        if (
          origin === undefined ||
          origin.provenance === 'claimed' ||
          !origin.wordsAvailable ||
          config.readOriginWords === undefined
        ) {
          return yield* new InteractionError({ reason: 'unavailable' })
        }
        const text = yield* config.readOriginWords(origin.locator)
        if (digest(text) !== origin.digest)
          return yield* new InteractionError({ reason: 'binding' })
        reply = renderWordsReply(current.payload, { digest: origin.digest, text }, config)
      } else reply = renderInspectReply(current.payload, config)
      if (reply._tag === 'Rejected') return yield* new InteractionError({ reason: 'body' })
      yield* discord.ephemeral(interaction.application_id, interaction.token, reply.message)
    } else if (job !== undefined) yield* submit(job)
  })
  /** Before accepting traffic: reconcile durable outbox, then retire every stale original card. */
  const recover = Effect.fn('scg.discord.recover')(function* () {
    yield* io('discard-unacknowledged', () => store.discardUnacknowledged())
    for (const job of yield* io('load-jobs', () => store.jobs())) yield* submit(job)
    for (const card of yield* io('load-cards', () => store.cards())) {
      yield* publish(card.record, card.channelId)
    }
  })
  return { handle, recover, submit, close, publish }
}
