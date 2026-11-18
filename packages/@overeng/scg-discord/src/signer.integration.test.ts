import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { it } from '@effect/vitest'
import { Deferred, Effect, Exit, FileSystem, Layer, Schema } from 'effect'
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

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
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
const io = <T>({ operation, run }: { readonly operation: string; readonly run: () => T }) =>
  Effect.try({ try: run, catch: (cause) => new DiscordError({ operation, cause }) })

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = fileURLToPath(new URL('../../../../tmp/scg-discord-tests/', import.meta.url))
  yield* fs.makeDirectory(root, { recursive: true })
  const directory = yield* fs.makeTempDirectoryScoped({ directory: root, prefix: 'case-' })
  let executions = 0
  let decisions = 0
  let time = now
  let clock = () => time
  let executorBarrier: Promise<void> = Promise.resolve()
  const options: AuthorityOptions = {
    dbPath: `${directory}/authority.sqlite`,
    authority: { keyId: 'authority', privateKey: keys.authority.privateKey },
    signers: [{ ...signerIdentity, publicKey: keys.signer.publicKey }],
    callers: [{ ...owner, publicKey: keys.caller.publicKey }],
    audience: 'synthetic-executor',
    release: 'integration',
    now: () => clock(),
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
      await executorBarrier
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
    post: ({ channelId }) =>
      Effect.sync(() => {
        events.push('post')
        return { id: randomUUID(), channel_id: channelId }
      }),
    edit: ({ message }) =>
      Effect.gen(function* () {
        if (rejectEdits === true)
          return yield* new DiscordError({
            operation: 'synthetic-delivery',
            cause: 'Delivery interrupted',
          })
        events.push('edit')
        messages.push(message)
      }),
    ephemeral: ({ message }) =>
      Effect.sync(() => {
        events.push('ephemeral')
        messages.push(message)
      }),
  }
  const client: AuthorityClient = {
    pending: (id) =>
      io({
        operation: 'pending',
        run: () => {
          events.push('pending')
          return authority.pending({ signer: signerIdentity, id: id })
        },
      }),
    status: (id) =>
      io({
        operation: 'status',
        run: () => authority.signerStatus({ signer: signerIdentity, id: id }),
      }),
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
    const status = authority.submit({
      owner: owner,
      submitted: {
        epoch: 'scg-experiment-v1',
        catalogDigest: digest(catalog),
        idempotencyKey: randomUUID(),
        action: {
          commandId: 'calendar.list',
          account: 'test-account',
          args: { from: '2027-01-01' },
        },
        claimed: { intent: 'Plan a synthetic day', sensitivity: 'low' },
      },
    })
    return authority.pending({ signer: signerIdentity, id: status.executionId })
  }
  const track = (record = pending()): Card =>
    store.add({ record: record, channelId: 'test-channel', messageId: randomUUID() })
  const request = ({
    card,
    customId = card.controls[0]!.id,
    interactionId = randomUUID(),
  }: {
    readonly card: Card
    readonly customId?: string
    readonly interactionId?: string
  }) => {
    const requestedAt = clock()
    const timestamp = String(Math.floor(requestedAt / 1000))
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
      nowMs: requestedAt,
      acknowledge: ({
        body,
      }: {
        readonly status: number
        readonly body: { readonly type: number }
      }) => {
        events.push(`ack:${body.type}`)
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
    signer: () =>
      makeSigner({ config: config, store: store, authority: client, discord: delivery }),
    store: () => store,
    authority: () => authority,
    executions: () => executions,
    decisions: () => decisions,
    delayExecution: () => {
      const gate = Promise.withResolvers<void>()
      executorBarrier = gate.promise
      return () => gate.resolve()
    },
    restartSigner: () => {
      store.close()
      store = new DiscordStore(`${directory}/discord.sqlite`)
    },
    setTime: (value: number) => {
      time = value
    },
    useLiveClock: () => {
      clock = Date.now
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
      sync: (cursor) =>
        io({
          operation: 'sync',
          run: () => f.authority().sync({ signer: signerIdentity, cursor: cursor }),
        }),
    }
    f.rejectEdits(true)
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          syncDiscordSurface({
            signer: signer,
            store: f.store(),
            authority: client,
            channelId: 'test-channel',
          }),
        ),
      ),
    ).toBe(true)
    const card = f.store().cards()[0]!
    expect(f.events).toEqual(['post'])
    f.rejectEdits(false)
    yield* syncDiscordSurface({
      signer: signer,
      store: f.store(),
      authority: client,
      channelId: 'test-channel',
    })
    expect(f.events).toEqual(['post', 'edit'])
    expect(f.store().cards()).toEqual([card])
    expect(encodeJson(f.messages[0])).toContain(card.controls[0]!.id)
    const release = f.delayExecution()
    yield* signer.handle(f.request({ card: card }))
    expect(f.store().cards()).toEqual([card])
    expect(encodeJson(f.messages.at(-1))).not.toContain(card.controls[0]!.id)
    expect(
      f.authority().signerStatus({ signer: signerIdentity, id: record.payload.executionId }).state,
    ).toBe('reserved')
    release()
    yield* Effect.promise(() => f.authority().drain())
    const delivered = f.messages.length
    yield* signer.publish({ record: record, channelId: 'test-channel' })
    expect(f.messages).toHaveLength(delivered + 1)
    expect(encodeJson(f.messages.at(-1))).not.toContain(card.controls[0]!.id)
    const finalMessage = f.messages.at(-1)
    yield* signer.publish({ record: record, channelId: 'test-channel' })
    expect(f.messages).toHaveLength(delivered + 1)
    expect(f.messages.at(-1)).toEqual(finalMessage)
    expect(encodeJson(finalMessage)).toContain('· ran.')
    expect(f.executions()).toBe(1)
    expect(f.events.filter((event) => event === 'post')).toHaveLength(1)
    expect(f.store().cards()).toHaveLength(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect(
  'ACKs deferred update before network work and closes only after durable authority acceptance',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const release = f.delayExecution()
      const card = f.track()
      yield* f.signer().handle(f.request({ card: card }))
      expect(f.events).toEqual(['ack:6', 'pending', 'decide', 'edit'])
      expect(
        f.authority().signerStatus({ signer: signerIdentity, id: card.record.payload.executionId })
          .state,
      ).toBe('reserved')
      expect(f.store().cards()).toEqual([card])
      expect(encodeJson(f.messages.at(-1))).not.toContain(card.controls[0]!.id)
      release()
      yield* Effect.promise(() => f.authority().drain())
      yield* f.signer().publish({ record: card.record, channelId: card.channelId })
      expect(f.events).toEqual(['ack:6', 'pending', 'decide', 'edit', 'edit'])
      expect(f.executions()).toBe(1)
      expect(f.store().cards()).toHaveLength(0)
      expect(f.store().jobs()).toHaveLength(0)
      expect(
        f.authority().signerStatus({ signer: signerIdentity, id: card.record.payload.executionId })
          .decisionDigest,
      ).toMatch(/^sha256:/)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('competing signed replays create one durable job and one execution', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const card = f.track()
    const input = f.request({ card: card })
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
    const input = f.request({ card: card, customId: card.inspectId })
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
      expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(f.request({ card: card }))))).toBe(
        true,
      )
      yield* Effect.promise(() => f.authority().drain())
      expect(f.store().jobs()).toHaveLength(1)
      f.restart()
      f.rejectEdits(false)
      yield* f.signer().recover
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
    const denied = signPayload({
      domain: 'decision',
      payload: {
        epoch: 'scg-experiment-v1' as const,
        kind: 'decision' as const,
        executionId: card.record.payload.executionId,
        pendingDigest: digest(card.record.payload),
        optionId: 'deny',
        principalId: signerIdentity.principalId,
        surfaceId: signerIdentity.surfaceId,
        decidedAt: now,
      },
      keyId: signerIdentity.keyId,
      key: keys.signer.privateKey,
    })
    yield* Effect.promise(() => f.authority().decide(denied))
    const expiring = f.track()
    f.setTime(now + 60_001)
    yield* f.signer().recover
    expect(f.store().cards()).toHaveLength(0)
    expect(f.messages.map((message) => JSON.stringify(message))).toEqual(
      expect.arrayContaining([
        expect.stringContaining('on another surface'),
        expect.stringContaining('Expired'),
      ]),
    )
    expect(f.messages.every((message) => !JSON.stringify(message).includes('custom_id'))).toBe(true)
    expect(
      f
        .authority()
        .signerStatus({ signer: signerIdentity, id: expiring.record.payload.executionId }).state,
    ).toBe('expired')
    expect(f.executions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect('wrong digest/account/signature bindings and wrong message/channel never sign', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const original = f.pending()
    const changed: SignedPending = signPayload({
      domain: 'pending',
      payload: {
        ...original.payload,
        review: { ...original.payload.review, account: 'wrong-account' },
      },
      keyId: 'authority',
      key: keys.authority.privateKey,
    })
    const card = f.track(changed)
    expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(f.request({ card: card }))))).toBe(
      true,
    )
    expect(f.decisions()).toBe(0)
    const wrong = f.request({ card: { ...card, channelId: 'wrong-channel' } })
    expect(Exit.isFailure(yield* Effect.exit(f.signer().handle(wrong)))).toBe(true)
    expect(f.decisions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

// HTTP transport deadlines use the platform clock; a TestClock cannot advance network callbacks.
it.live('real HTTP route returns type-6 ACK while authority acceptance is still blocked', () =>
  Effect.gen(function* () {
    const run = Effect.runPromiseWith(yield* Effect.context<never>())
    const f = yield* fixture
    // Authority, Discord timestamp and the real HTTP handler must read the same
    // advancing clock, not a one-time snapshot preceding authority acceptance.
    f.useLiveClock()
    const card = f.track()
    const acceptance = yield* Deferred.make<void>()
    const completed = yield* Deferred.make<void, DiscordError>()
    const signer = makeSigner({
      config: config,
      store: f.store(),
      authority: {
        ...f.client,
        decide: (candidate) =>
          Deferred.await(acceptance).pipe(Effect.andThen(f.client.decide(candidate))),
      },
      discord: f.delivery,
    })
    const server = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          const { promise, resolve, reject } = Promise.withResolvers<Server>()
          const handler = makeInteractionHttpHandler({
            signer: {
              ...signer,
              handle: (input) =>
                signer.handle(input).pipe(Effect.tap(() => Deferred.succeed(completed, undefined))),
            },
            onFailure: (cause) => {
              void run(
                Deferred.fail(
                  completed,
                  new DiscordError({ operation: 'test-interaction', cause }),
                ),
              )
            },
          })
          const instance = createServer((request, response) => handler({ request, response }))
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
    const input = f.request({ card: card })
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
    yield* Deferred.await(completed)
    yield* Effect.promise(() => f.authority().drain())
    expect(f.decisions()).toBe(1)
    expect(f.store().jobs()).toHaveLength(0)
    expect(f.executions()).toBe(1)
  }).pipe(Effect.provide(Layer.merge(FetchHttpClient.layer, NodeServices.layer)), Effect.scoped),
)

it.effect('an elapsed HTTP ACK deadline never becomes a decision after restart', () =>
  Effect.gen(function* () {
    const f = yield* fixture
    const card = f.track()
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          f.signer().handle({ ...f.request({ card: card }), acknowledge: () => false }),
        ),
      ),
    ).toBe(true)
    f.restart()
    yield* f.signer().recover
    expect(f.decisions()).toBe(0)
    expect(f.executions()).toBe(0)
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)

it.effect(
  'reserved cards survive restart and failed final delivery until the delayed executor finishes',
  () =>
    Effect.gen(function* () {
      const f = yield* fixture
      const release = f.delayExecution()
      const card = f.track()
      yield* f.signer().handle(f.request({ card: card }))
      const reserved = yield* f.client.status(card.record.payload.executionId)
      expect(reserved.state).toBe('reserved')
      expect(f.store().cards()).toHaveLength(1)
      expect(encodeJson(f.messages.at(-1))).toContain('running')
      f.restartSigner()
      yield* f.signer().recover
      expect(f.store().cards()).toHaveLength(1)
      release()
      yield* Effect.tryPromise({
        try: async () => {
          for (let turn = 0; turn < 1_000; turn += 1) {
            if (
              f
                .authority()
                .signerStatus({ signer: signerIdentity, id: card.record.payload.executionId })
                .state !== 'reserved'
            )
              return
            await setImmediate()
          }
          throw new Error('Executor did not finish')
        },
        catch: (cause) => new DiscordError({ operation: 'await-test-executor', cause }),
      })
      const client: SyncAuthorityClient = {
        ...f.client,
        sync: () => Effect.succeed({ cursor: 7, pending: [], terminal: [] }),
      }
      f.rejectEdits(true)
      expect(
        Exit.isFailure(
          yield* Effect.exit(
            syncDiscordSurface({
              signer: f.signer(),
              store: f.store(),
              authority: client,
              channelId: 'test-channel',
            }),
          ),
        ),
      ).toBe(true)
      expect(f.store().cards()).toHaveLength(1)
      expect(f.store().cursor()).toBe(0)
      f.rejectEdits(false)
      yield* syncDiscordSurface({
        signer: f.signer(),
        store: f.store(),
        authority: client,
        channelId: 'test-channel',
      })
      expect(f.store().cards()).toHaveLength(0)
      expect(f.store().cursor()).toBe(7)
      const finalMessage = f.messages.at(-1)
      yield* f.signer().close({ card: card, status: reserved, elsewhere: false })
      expect(f.messages.at(-1)).toEqual(finalMessage)
      expect(f.executions()).toBe(1)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
)
