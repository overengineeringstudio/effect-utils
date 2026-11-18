import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Deferred, Effect, Exit, FileSystem } from 'effect'
import { FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http'
import { expect } from 'vitest'

import { createAuthority, type Authority, type AuthorityOptions } from '@overeng/scg-authority'
import { digest, signPayload, type Catalog, type SignedPending } from '@overeng/scg-protocol'

import type { DiscordMessage } from './card.ts'
import { makeInteractionHttpHandler } from './http.ts'
import {
  DiscordError,
  makeSigner,
  type AuthorityClient,
  type DiscordDelivery,
  type SignerConfig,
} from './signer.ts'
import { DiscordStore, type Card } from './store.ts'
import { syncDiscordSurface, type SyncAuthorityClient } from './sync.ts'

const keys = {
  discord: generateKeyPairSync('ed25519'),
  authority: generateKeyPairSync('ed25519'),
  signer: generateKeyPairSync('ed25519'),
  caller: generateKeyPairSync('ed25519'),
}
const now = 1_800_000_000_000
const owner = { identity: 'test-agent', keyId: 'caller' }
const signerIdentity = { keyId: 'discord-signer', surfaceId: 'discord-test', principalId: 'human' }
const catalog: Catalog = {
  epoch: 'scg-experiment-v1',
  revision: 'synthetic-1',
  entries: [
    {
      commandId: 'calendar.list',
      accounts: ['test-account'],
      argsSchema: { type: 'object' },
      sensitivity: 'low',
      description: 'Synthetic calendar read',
    },
  ],
}
const config: SignerConfig = {
  applicationId: 'synthetic-app',
  allowedUserIds: new Set(['human']),
  discordPublicKey: keys.discord.publicKey,
  authorityKeyId: 'authority',
  authorityPublicKey: keys.authority.publicKey,
  surfaceId: signerIdentity.surfaceId,
  signerKeyId: signerIdentity.keyId,
  signerPrivateKey: keys.signer.privateKey,
  timeZone: 'Europe/Berlin',
}
const io = <T>(operation: string, run: () => T) =>
  Effect.try({ try: run, catch: (cause) => new DiscordError({ operation, cause }) })

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = fileURLToPath(new URL('../../../../tmp/scg-discord-tests/', import.meta.url))
  yield* fs.makeDirectory(root, { recursive: true })
  const directory = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: 'case-' })
  let executions = 0
  let decisions = 0
  let time = now
  const options: AuthorityOptions = {
    dbPath: `${directory}/authority.sqlite`,
    authority: { keyId: 'authority', privateKey: keys.authority.privateKey },
    signers: [{ ...signerIdentity, publicKey: keys.signer.publicKey }],
    callers: [{ ...owner, publicKey: keys.caller.publicKey }],
    audience: 'synthetic-executor',
    release: 'integration',
    now: () => time,
    pendingTtlMs: 60_000,
    catalog: {
      catalog,
      admit: (action) => ({
        action,
        fields: [{ label: 'From', value: String(action.args.from) }],
        sensitivity: 'low',
      }),
    },
    executor: async () => {
      executions += 1
      return { state: 'succeeded', result: 'synthetic-calendar' }
    },
  }
  let authority: Authority = createAuthority(options)
  let store = new DiscordStore(`${directory}/discord.sqlite`)
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      store.close()
      authority.close()
    }),
  )
  const events: string[] = []
  const messages: DiscordMessage[] = []
  let rejectEdits = false
  const delivery: DiscordDelivery = {
    post: (channelId) =>
      Effect.sync(() => {
        events.push('post')
        return { id: randomUUID(), channel_id: channelId }
      }),
    edit: (_card, message) =>
      Effect.gen(function* () {
        if (rejectEdits)
          return yield* new DiscordError({
            operation: 'synthetic-delivery',
            cause: 'Delivery interrupted',
          })
        events.push('edit')
        messages.push(message)
      }),
    ephemeral: (_app, _token, message) =>
      Effect.sync(() => {
        events.push('ephemeral')
        messages.push(message)
      }),
  }
  const client: AuthorityClient = {
    pending: (id) =>
      io('pending', () => {
        events.push('pending')
        return authority.pending(signerIdentity, id)
      }),
    status: (id) => io('status', () => authority.signerStatus(signerIdentity, id)),
    decide: (decision) =>
      Effect.tryPromise({
        try: async () => {
          decisions += 1
          events.push('decide')
          return authority.decide(decision)
        },
        catch: (cause) => new DiscordError({ operation: 'decide', cause }),
      }),
  }
  const pending = () => {
    const status = authority.submit(owner, {
      epoch: 'scg-experiment-v1',
      catalogDigest: digest(catalog),
      idempotencyKey: randomUUID(),
      action: { commandId: 'calendar.list', account: 'test-account', args: { from: '2027-01-01' } },
      claimed: { intent: 'Plan a synthetic day', sensitivity: 'low' },
    })
    return authority.pending(signerIdentity, status.executionId)
  }
  const track = (record = pending()): Card => store.add(record, 'test-channel', randomUUID())
  const request = (card: Card, customId = card.controls[0]!.id, interactionId = randomUUID()) => {
    const timestamp = String(Math.floor(time / 1000))
    const body = Buffer.from(
      JSON.stringify({
        id: interactionId,
        application_id: config.applicationId,
        token: 'synthetic-interaction-token',
        type: 3,
        user: { id: 'human' },
        message: { id: card.messageId, channel_id: card.channelId },
        data: { custom_id: customId },
      }),
    )
    return {
      body,
      timestamp,
      signature: sign(
        null,
        Buffer.concat([Buffer.from(timestamp), body]),
        keys.discord.privateKey,
      ).toString('hex'),
      nowMs: time,
      acknowledge: (_status: number, value: { readonly type: number }) => {
        events.push(`ack:${value.type}`)
        return true
      },
    }
  }
  return {
    pending,
    track,
    request,
    events,
    messages,
    client,
    delivery,
    options,
    signer: () => makeSigner(config, store, client, delivery),
    store: () => store,
    authority: () => authority,
    executions: () => executions,
    decisions: () => decisions,
    setTime: (value: number) => {
      time = value
    },
    rejectEdits: (value: boolean) => {
      rejectEdits = value
    },
    restart: () => {
      store.close()
      authority.close()
      store = new DiscordStore(`${directory}/discord.sqlite`)
      authority = createAuthority(options)
    },
  }
})

it.effect('retries interrupted activation without reposting or reactivating a closed review', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const record = f.pending()
    const signer = f.signer()
    const client: SyncAuthorityClient = {
      ...f.client,
      sync: (cursor) => io('sync', () => f.authority().sync(signerIdentity, cursor)),
    }
    f.rejectEdits(true)
    expect(
      Exit.isFailure(
        yield* Effect.exit(syncDiscordSurface(signer, f.store(), client, 'test-channel')),
      ),
    ).toBe(true)
    const card = f.store().cards()[0]!
    expect(f.events).toEqual(['post'])
    f.rejectEdits(false)
    yield* syncDiscordSurface(signer, f.store(), client, 'test-channel')
    expect(f.events).toEqual(['post', 'edit'])
    expect(f.store().cards()).toEqual([card])
    expect(JSON.stringify(f.messages[0])).toContain(card.controls[0]!.id)
    yield* signer.handle(f.request(card))
    yield* Effect.promise(() => f.authority().drain())
    const delivered = f.messages.length
    yield* signer.publish(record, 'test-channel')
    expect(f.messages).toHaveLength(delivered)
    expect(f.events.filter((event) => event === 'post')).toHaveLength(1)
    expect(f.store().cards()).toHaveLength(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect(
  'ACKs deferred update before network work and closes only after durable authority acceptance',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const card = f.track()
      yield* f.signer().handle(f.request(card))
      yield* Effect.promise(() => f.authority().drain())
      expect(f.events).toEqual(['ack:6', 'pending', 'decide', 'edit'])
      expect(f.executions()).toBe(1)
      expect(f.store().cards()).toHaveLength(0)
      expect(f.store().jobs()).toHaveLength(0)
      expect(
        f.authority().signerStatus(signerIdentity, card.record.payload.executionId).decisionDigest,
      ).toMatch(/^sha256:/)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('competing signed replays create one durable job and one execution', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const card = f.track()
    const input = f.request(card)
    const results = yield* Effect.all(
      [Effect.exit(f.signer().handle(input)), Effect.exit(f.signer().handle(input))],
      { concurrency: 'unbounded' },
    )
    yield* Effect.promise(() => f.authority().drain())
    expect(results.filter(Exit.isSuccess)).toHaveLength(1)
    expect(f.decisions()).toBe(1)
    expect(f.executions()).toBe(1)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('Inspect is ephemeral and never signs; replay protection survives restart', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const card = f.track()
    const input = f.request(card, card.inspectId)
    yield* f.signer().handle(input)
    expect(f.messages[0]?.flags).toBe(32832)
    expect(f.decisions()).toBe(0)
    f.restart()
    expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(input)))).toBe(true)
    expect(f.decisions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect(
  'reconciles accepted decisions and stale cards after restart without resubmitting or rerunning',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const card = f.track()
      f.rejectEdits(true)
      expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(f.request(card))))).toBe(true)
      yield* Effect.promise(() => f.authority().drain())
      expect(f.store().jobs()).toHaveLength(1)
      f.restart()
      f.rejectEdits(false)
      yield* f.signer().recover()
      expect(f.executions()).toBe(1)
      expect(f.decisions()).toBe(1)
      expect(f.store().jobs()).toHaveLength(0)
      expect(f.store().cards()).toHaveLength(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('expired and decided-elsewhere cards lose all controls on recovery', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const card = f.track()
    const denied = signPayload(
      'decision',
      {
        epoch: 'scg-experiment-v1' as const,
        kind: 'decision' as const,
        executionId: card.record.payload.executionId,
        pendingDigest: digest(card.record.payload),
        optionId: 'deny',
        principalId: signerIdentity.principalId,
        surfaceId: signerIdentity.surfaceId,
        decidedAt: now,
      },
      signerIdentity.keyId,
      keys.signer.privateKey,
    )
    yield* Effect.promise(() => f.authority().decide(denied))
    const expiring = f.track()
    f.setTime(now + 60_001)
    yield* f.signer().recover()
    expect(f.store().cards()).toHaveLength(0)
    expect(f.messages.map((message) => JSON.stringify(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('elsewhere'),
        expect.stringContaining('Expired'),
      ]),
    )
    expect(f.messages.every((message) => !JSON.stringify(message).includes('custom_id'))).toBe(true)
    expect(
      f.authority().signerStatus(signerIdentity, expiring.record.payload.executionId).state,
    ).toBe('expired')
    expect(f.executions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('wrong digest/account/signature bindings and wrong message/channel never sign', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const original = f.pending()
    const changed: SignedPending = signPayload(
      'pending',
      { ...original.payload, review: { ...original.payload.review, account: 'wrong-account' } },
      'authority',
      keys.authority.privateKey,
    )
    const card = f.track(changed)
    expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(f.request(card))))).toBe(true)
    expect(f.decisions()).toBe(0)
    const wrong = f.request({ ...card, channelId: 'wrong-channel' })
    expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(wrong)))).toBe(true)
    expect(f.decisions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('real HTTP route returns type-6 ACK while authority acceptance is still blocked', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    f.setTime(Date.now())
    const card = f.track()
    const acceptance = yield* Deferred.make<void>()
    const edited = yield* Deferred.make<void>()
    const signer = makeSigner(
      config,
      f.store(),
      {
        ...f.client,
        decide: (candidate) =>
          Deferred.await(acceptance).pipe(Effect.andThen(f.client.decide(candidate))),
      },
      {
        ...f.delivery,
        edit: (target, message) =>
          f.delivery
            .edit(target, message)
            .pipe(Effect.tap(() => Deferred.succeed(edited, undefined))),
      },
    )
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const { promise, resolve, reject } = Promise.withResolvers<Server>()
          const instance = createServer(
            makeInteractionHttpHandler(signer, () => {
              /* Rejections are asserted by the HTTP response. */
            }),
          )
          instance.once('error', reject)
          instance.listen(0, '127.0.0.1', () => resolve(instance))
          return promise
        },
        catch: (cause) => new DiscordError({ operation: 'test-listen', cause }),
      }),
      (instance) =>
        Effect.promise(() => {
          const { promise, resolve } = Promise.withResolvers<void>()
          instance.close(() => resolve())
          instance.closeAllConnections()
          return promise
        }),
    )
    const address = server.address()
    if (address === null || typeof address === 'string')
      return yield* Effect.die('Expected TCP test listener')
    const input = f.request(card)
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(
      HttpClientRequest.post(`http://127.0.0.1:${address.port}/interactions`).pipe(
        HttpClientRequest.setHeaders({
          'x-signature-ed25519': input.signature,
          'x-signature-timestamp': input.timestamp,
        }),
        HttpClientRequest.bodyUint8Array(input.body),
      ),
    )
    expect(response.status).toBe(200)
    expect(yield* response.json).toEqual({ type: 6 })
    expect(f.messages).toHaveLength(0)
    expect(f.decisions()).toBe(0)
    yield* Deferred.succeed(acceptance, undefined)
    yield* Deferred.await(edited)
    expect(f.decisions()).toBe(1)
  }).pipe(Effect.provide(FetchHttpClient.layer), Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('an elapsed HTTP ACK deadline never becomes a decision after restart', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const card = f.track()
    expect(
      Exit.isFailure(
        yield* Effect.exit(f.signer().handle({ ...f.request(card), acknowledge: () => false })),
      ),
    ).toBe(true)
    f.restart()
    yield* f.signer().recover()
    expect(f.decisions()).toBe(0)
    expect(f.executions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
