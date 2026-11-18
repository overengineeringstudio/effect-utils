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

/** Structured signer transport or journal failure; callers redact private causes in logs. */
export class DiscordError extends Schema.TaggedError<DiscordError>()('DiscordError', {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}
/** Authenticated authority operations used after ACK and during reconciliation. */
export interface AuthorityClient {
  readonly pending: (executionId: string) => Effect.Effect<SignedPending, DiscordError>
  /** Resolves only once the authority has durably accepted or reports the winning terminal state. */
  readonly decide: (decision: SignedDecision) => Effect.Effect<Status, DiscordError>
  readonly status: (executionId: string) => Effect.Effect<Status, DiscordError>
}
/** Delivery boundary for original cards and private inspection replies. */
export interface DiscordDelivery {
  readonly post: (options: { readonly channelId: string; readonly message: DiscordMessage }) =>
    Effect.Effect<{ readonly id: string; readonly channel_id: string }, DiscordError>
  readonly edit: (options: { readonly card: Card; readonly message: DiscordMessage }) =>
    Effect.Effect<void, DiscordError>
  readonly ephemeral: (options: {
    readonly applicationId: string
    readonly token: string
    readonly message: DiscordMessage
  }) => Effect.Effect<void, DiscordError>
}
/** Enrolled identities, trusted keys and privacy-preserving origin lookup. */
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
/** Raw Discord request and deadline-aware synchronous response boundary. */
export interface InteractionInput {
  readonly body: Uint8Array
  readonly signature: string | undefined
  readonly timestamp: string | undefined
  readonly nowMs: number
  /** Flush/end the HTTP response; false means the deadline elapsed, so do no remote work. */
  readonly acknowledge: (options: { readonly status: number; readonly body: { readonly type: number } }) => boolean
}
/** Durable lifecycle separating acceptance from final visible outcome delivery. */
export interface DiscordSigner {
  readonly handle: (input: InteractionInput) => Effect.Effect<void, InteractionError | DiscordError>
  readonly recover: () => Effect.Effect<void, InteractionError | DiscordError>
  readonly submit: (job: Job) => Effect.Effect<void, InteractionError | DiscordError>
  readonly close: (options: {
    readonly card: Card
    readonly status: Status
    readonly elsewhere: boolean
  }) => Effect.Effect<void, InteractionError | DiscordError>
  readonly publish: (options: {
    readonly record: SignedPending
    readonly channelId: string
  }) => Effect.Effect<void, InteractionError | DiscordError>
}
const io = <T>({ operation, run }: { readonly operation: string; readonly run: () => T }) =>
  Effect.try({ try: run, catch: (cause) => new DiscordError({ operation, cause }) })

/** Composes verification, replay control, signing and serialized card reconciliation. */
export const makeSigner = ({ config, store, authority, discord }: {
  readonly config: SignerConfig
  readonly store: DiscordStore
  readonly authority: AuthorityClient
  readonly discord: DiscordDelivery
}): DiscordSigner => {
  // Status-read/render/PATCH and terminal PATCH/journal-close are one serialized
  // transition; a suspended origin read must never overwrite a terminal edit.
  const edits = Semaphore.makeUnsafe(1)
  const verified = (record: SignedPending): boolean =>
    record.keyId === config.authorityKeyId &&
    verifyPayload({ domain: 'pending', envelope: record, key: config.authorityPublicKey })
  const render = Effect.fn('scg.discord.render')(function* (card: Card) {
    let originWords
    const origin = card.record.payload.review.context?.origin
    if (
      origin !== undefined &&
      origin.surface === 'discord' &&
      origin.provenance !== 'claimed' &&
      card.record.payload.review.sensitivity === 'low' &&
      origin.wordsAvailable === true &&
      config.readOriginWords !== undefined
    ) {
      const text = yield* config.readOriginWords(origin.locator)
      if (digest(text) !== origin.digest) return yield* new InteractionError({ reason: 'binding' })
      originWords = { digest: origin.digest, text }
    }
    const result = renderPendingCard({ pending: card.record.payload, ids: {
      options: Object.fromEntries(card.controls.map(({ optionId, id }) => [optionId, id])),
      inspect: card.inspectId,
      words: card.wordsId,
    }, env: config, originWords: originWords })
    if (result._tag === 'Rejected') return yield* new InteractionError({ reason: 'body' })
    return result.message
  })
  const publishUnlocked = Effect.fn('scg.discord.publish')(function* ({ record, channelId }: {
    readonly record: SignedPending
    readonly channelId: string
  }) {
    if (verified(record) === false) return yield* new InteractionError({ reason: 'signature' })
    if ((yield* io({ operation: 'find-publication', run: () => store.has(record.payload.executionId) })) === true) {
      const existing = yield* io({ operation: 'find-open-publication', run: () =>
        store
          .cards()
          .find((card) => card.record.payload.executionId === record.payload.executionId) })
      // A failed activation PATCH leaves an open journal entry. Retry the exact
      // durable control mapping, but never reactivate a closed or resolved review.
      if (existing !== undefined) {
        const status = yield* authority.status(record.payload.executionId)
        if (status.state === 'pending') yield* discord.edit({ card: existing, message: yield* render(existing) })
        else yield* closeUnlocked({ card: existing, status: status, elsewhere: true })
      }
      return
    }
    // Never expose an enabled control before its exact mapping is durably journaled.
    const posted = yield* discord.post({ channelId: channelId, message: {
      flags: 32768,
      allowed_mentions: { parse: [] },
      components: [{ type: 10, content: 'Authenticating review. No decision is available yet.' }],
    } })
    const card = yield* io({ operation: 'add-card', run: () => store.add({ record: record, channelId: posted.channel_id, messageId: posted.id }) })
    yield* discord.edit({ card: card, message: yield* render(card) })
  })
  const closeUnlocked = Effect.fn('scg.discord.close')(function* ({ card, status: observed, elsewhere }: {
    readonly card: Card
    readonly status: Status
    readonly elsewhere: boolean
  }) {
    // Resolve status under the same lock as PATCH: an old reserved observation must
    // never overwrite a final outcome delivered by another reconciliation.
    if (
      store
        .cards()
        .some((item) => item.record.payload.executionId === card.record.payload.executionId) === false
    )
      return
    const status = yield* authority.status(card.record.payload.executionId)
    if (
      status.executionId !== card.record.payload.executionId ||
      status.requestDigest !== card.record.payload.requestDigest ||
      observed.executionId !== card.record.payload.executionId ||
      observed.requestDigest !== card.record.payload.requestDigest
    ) {
      return yield* new InteractionError({ reason: 'binding' })
    }
    if (status.state === 'pending') return
    const rendered = renderClosedCard({ pending: card.record.payload, closure: { _tag: 'Resolved', state: status.state, decidedElsewhere: elsewhere }, env: config })
    if (rendered._tag === 'Rejected') return yield* new InteractionError({ reason: 'body' })
    yield* discord.edit({ card: card, message: rendered.message })
    // Reservation removes controls, but its mapping remains durable until the
    // actual execution outcome has been visibly delivered.
    if (status.state !== 'reserved')
      yield* io({ operation: 'close-card', run: () => store.closed(card.record.payload.executionId) })
  })
  const publish: DiscordSigner['publish'] = (options) =>
    publishUnlocked(options).pipe(Semaphore.withPermits(edits, 1))
  const close: DiscordSigner['close'] = (options) =>
    closeUnlocked(options).pipe(Semaphore.withPermits(edits, 1))
  const submit = Effect.fn('scg.discord.submit')(function* (job: Job) {
    if (verified(job.card.record) === false) return yield* new InteractionError({ reason: 'signature' })
    const candidate = signPayload({ domain: 'decision', payload: job.decision, keyId: config.signerKeyId, key: config.signerPrivateKey })
    const previous = yield* authority.status(job.card.record.payload.executionId)
    const status = previous.state === 'pending' ? yield* authority.decide(candidate) : previous
    if (status.state === 'pending') return yield* new InteractionError({ reason: 'unavailable' })
    yield* close({ card: job.card, status: status, elsewhere: status.decisionDigest !== digest(candidate) })
    yield* io({ operation: 'complete-job', run: () => store.complete(job.interactionId) })
  })
  const handle = Effect.fn('scg.discord.handle')(function* (input: InteractionInput) {
    const interaction = yield* verifyInteraction({
      ...input,
      publicKey: config.discordPublicKey,
      applicationId: config.applicationId,
      allowedUserIds: config.allowedUserIds,
    })
    if (interaction.type === 1) {
      input.acknowledge({ status: 200, body: { type: 1 } })
      return
    }
    const message = interaction.message
    const customId = interaction.data?.custom_id
    if (message === undefined || customId === undefined)
      return yield* new InteractionError({ reason: 'binding' })
    const card = yield* io({ operation: 'find-card', run: () => store.find({ messageId: message.id, channelId: message.channel_id }) })
    if (card === undefined || verified(card.record) === false)
      return yield* new InteractionError({ reason: 'binding' })
    const selected = card.controls.find(({ id }) => id === customId)
    const inspect = card.inspectId === customId
    const words = card.wordsId === customId
    if (selected === undefined && inspect === false && words === false)
      return yield* new InteractionError({ reason: 'binding' })
    if (card.record.payload.expiresAt <= input.nowMs)
      return yield* new InteractionError({ reason: 'timestamp' })
    const principalId = interaction.member?.user.id ?? interaction.user?.id
    if (principalId === undefined) return yield* new InteractionError({ reason: 'user' })
    const option = card.record.payload.options.find(
      ({ optionId }) => optionId === selected?.optionId,
    )
    if (
      inspect === false &&
      words === false &&
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
            decision: decisionFor({ card: card, optionId: option.optionId, principalId: principalId, surfaceId: config.surfaceId, decidedAt: input.nowMs }),
          }
    if (
      (yield* io({ operation: 'claim-interaction', run: () =>
        store.claim({ id: interaction.id, signedAt: Number(input.timestamp) * 1000, job: job }) })) === false
    ) {
      return yield* new InteractionError({ reason: 'replay' })
    }
    if (input.acknowledge({ status: 200, body: { type: 6 } }) === false)
      return yield* new InteractionError({ reason: 'timestamp' })
    if (job !== undefined) yield* io({ operation: 'acknowledge-job', run: () => store.acknowledged(interaction.id) })
    // All remote I/O occurs after the deferred-update ACK; receipt, never the click, closes the card.
    const current = yield* authority.pending(card.record.payload.executionId)
    if (verified(current) === false || digest(current.payload) !== digest(card.record.payload)) {
      yield* io({ operation: 'discard-invalid-candidate', run: () => store.complete(interaction.id) })
      return yield* new InteractionError({ reason: 'binding' })
    }
    if (inspect === true || words === true) {
      let reply: CardResult
      if (words === true) {
        const origin = current.payload.review.context?.origin
        if (
          origin === undefined ||
          origin.provenance === 'claimed' ||
          origin.wordsAvailable === false ||
          config.readOriginWords === undefined
        ) {
          return yield* new InteractionError({ reason: 'unavailable' })
        }
        const text = yield* config.readOriginWords(origin.locator)
        if (digest(text) !== origin.digest)
          return yield* new InteractionError({ reason: 'binding' })
        reply = renderWordsReply({ pending: current.payload, words: { digest: origin.digest, text }, env: config })
      } else reply = renderInspectReply({ pending: current.payload, env: config })
      if (reply._tag === 'Rejected') return yield* new InteractionError({ reason: 'body' })
      yield* discord.ephemeral({ applicationId: interaction.application_id, token: interaction.token, message: reply.message })
    } else if (job !== undefined) yield* submit(job)
  })
  /** Before accepting traffic: reconcile durable outbox, then retire every stale original card. */
  const recover = Effect.fn('scg.discord.recover')(function* () {
    yield* io({ operation: 'discard-unacknowledged', run: () => store.discardUnacknowledged() })
    for (const job of yield* io({ operation: 'load-jobs', run: () => store.jobs() })) yield* submit(job)
    for (const card of yield* io({ operation: 'load-cards', run: () => store.cards() })) {
      yield* publish({ record: card.record, channelId: card.channelId })
    }
  })
  return { handle, recover, submit, close, publish }
}
