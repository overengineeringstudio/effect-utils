import { Database } from 'bun:sqlite'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Exit, FileSystem, Scope } from 'effect'
import { afterEach, beforeEach, expect } from 'vitest'

import * as Protocol from '@overeng/scg-protocol'

import {
  AuthorityError,
  createAuthority,
  createHttpHandler,
  type Authority,
  type AuthorityOptions,
  type ExecutorResult,
} from './mod.ts'

const authorityKeys = generateKeyPairSync('ed25519')
const signerKeys = generateKeyPairSync('ed25519')
const callerKeys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
const owner: Protocol.Owner = { identity: 'agent', keyId: 'caller-key' }
const signer = { keyId: 'signer-key', principalId: 'human', surfaceId: 'review-ui' }
const catalog: Protocol.Catalog = {
  epoch: 'scg-experiment-v1',
  revision: 'test-1',
  entries: [
    {
      commandId: 'calendar.list',
      sensitivity: 'sensitive',
      description: 'List test calendar',
      accounts: ['test-account'],
      argsSchema: { type: 'object' },
    },
  ],
}
const action: Protocol.Action = {
  commandId: 'calendar.list',
  account: 'test-account',
  args: { from: '2026-11-18' },
}
const submitted = (idempotencyKey: string = randomUUID()): Protocol.Submitted => ({
  epoch: 'scg-experiment-v1',
  catalogDigest: Protocol.digest(catalog),
  idempotencyKey,
  action,
  claimed: { intent: 'Read the calendar for planning', sensitivity: 'low' },
})
const decision = ({
  pending,
  optionId,
  decidedAt = pending.payload.issuedAt,
}: {
  readonly pending: Protocol.SignedPending
  readonly optionId: 'allow-once' | 'deny'
  readonly decidedAt?: number
}): Protocol.SignedDecision =>
  Protocol.signPayload({ domain: 'decision', payload: {
    epoch: 'scg-experiment-v1',
    kind: 'decision',
    executionId: pending.payload.executionId,
    pendingDigest: Protocol.digest(pending.payload),
    optionId,
    principalId: signer.principalId,
    surfaceId: signer.surfaceId,
    decidedAt,
  }, keyId: signer.keyId, key: signerKeys.privateKey })

let directory: string
let time: number
let authority: Authority
let options: AuthorityOptions
let calls: Protocol.SignedDispatch[]
let releaseFixture: () => Promise<void>
const open = (executor?: AuthorityOptions['executor']): Authority => {
  authority = createAuthority({ ...options, ...(executor === undefined ? {} : { executor }) })
  return authority
}
beforeEach(async () => {
  // The promise-based authority tests share a filesystem scope spanning their Vitest hooks.
  const fixture = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const root = fileURLToPath(new URL('../../../../tmp/scg-authority-tests/', import.meta.url))
      yield* fs.makeDirectory(root, { recursive: true })
      const scope = yield* Scope.make()
      const path = yield* fs
        .makeTempDirectoryScoped({ directory: root, prefix: 'case-' })
        .pipe(Effect.provideService(Scope.Scope, scope))
      return { path, scope }
    }).pipe(Effect.provide(NodeServices.layer)),
  )
  directory = fixture.path
  releaseFixture = () => Effect.runPromise(Scope.close(fixture.scope, Exit.succeed(undefined)))
  time = 1_800_000_000_000
  calls = []
  options = {
    dbPath: `${directory}/authority.sqlite`,
    authority: { keyId: 'authority-key', privateKey: authorityKeys.privateKey },
    signers: [{ ...signer, publicKey: signerKeys.publicKey }],
    callers: [{ ...owner, publicKey: callerKeys.publicKey }],
    audience: 'local-test-executor',
    release: 'integration',
    now: () => time,
    pendingTtlMs: 1_000,
    catalog: {
      catalog,
      admit: (input) => {
        if (
          input.commandId !== action.commandId ||
          input.account !== action.account ||
          typeof input.args.from !== 'string'
        )
          throw new AuthorityError({ code: 'invalid-action' })
        return {
          action: input,
          fields: [{ label: 'From', value: input.args.from }],
          sensitivity: 'sensitive',
        }
      },
    },
    executor: async (dispatch) => {
      calls.push(dispatch)
      if (
        Protocol.verifyPayload({ domain: 'dispatch', envelope: dispatch, key: authorityKeys.publicKey }) === false ||
        Protocol.digestAction({ catalogDigest: dispatch.payload.catalogDigest, action: dispatch.payload.action }) !==
          dispatch.payload.actionDigest ||
        dispatch.payload.catalogDigest !== Protocol.digest(catalog) ||
        dispatch.payload.audience !== 'local-test-executor' ||
        dispatch.payload.deadline <= time
      )
        throw new AuthorityError({ code: 'invalid-dispatch' })
      return { state: 'succeeded', result: 'test-calendar-output' }
    },
  }
  open()
})
afterEach(async () => {
  try {
    authority.close()
  } finally {
    await releaseFixture()
  }
})

const request = ({
  path,
  method,
  body,
  keyId = owner.keyId,
  key = callerKeys.privateKey,
}: {
  readonly path: string
  readonly method: 'GET' | 'POST'
  readonly body: unknown
  readonly keyId?: string
  readonly key?: KeyObject
}): Request => {
  const auth = Protocol.signPayload({ domain: 'auth-request', payload: {
    epoch: 'scg-experiment-v1',
    method,
    path,
    bodyDigest: Protocol.digest(body),
    nonce: randomUUID(),
    issuedAt: time,
  }, keyId: keyId, key: key })
  return new Request(`http://authority.test${path}`, {
    method,
    headers: { 'x-scg-auth': JSON.stringify(auth) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  })
}

describe('durable exact-grant authority', () => {
  it('denies without dispatch and exposes terminal outbox without private payloads', async () => {
    const execution = authority.submit({ owner: owner, submitted: submitted() })
    const pending = authority.pending({ signer: signer, id: execution.executionId })
    expect(pending.payload.review.sensitivity).toBe('sensitive')
    expect(pending.payload.review.agentClaim).toBe('Read the calendar for planning')
    expect(Protocol.verifyPayload({ domain: 'pending', envelope: pending, key: authorityKeys.publicKey })).toBe(true)
    expect((await authority.decide(decision({ pending: pending, optionId: 'deny' }))).state).toBe('denied')
    await authority.drain()
    expect(calls).toHaveLength(0)
    const sync = authority.sync({ signer: signer, cursor: 0 })
    expect(sync.pending).toHaveLength(0)
    expect(sync.terminal.map((event) => event.state)).toEqual(['denied'])
    const db = new Database(options.dbPath, { readonly: true })
    try {
      const audit = db.query<{ digest: string }, []>('SELECT digest FROM audit').all()
      expect(audit.length).toBeGreaterThan(0)
      expect(audit.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.digest))).toBe(true)
      const columns = db
        .query<{ name: string }, []>('PRAGMA table_info(audit)')
        .all()
        .map((column) => column.name)
      expect(columns).toEqual(['sequence', 'digest'])
    } finally {
      db.close()
    }
  })

  it('expires without spending a grant and persists the terminal transition', async () => {
    const execution = authority.submit({ owner: owner, submitted: submitted() })
    const pending = authority.pending({ signer: signer, id: execution.executionId })
    time += 1_000
    expect((await authority.decide(decision({ pending: pending, optionId: 'allow-once' }))).state).toBe('expired')
    authority.close()
    open()
    expect(authority.status({ owner: owner, id: execution.executionId }).state).toBe('expired')
    expect(authority.sync({ signer: signer, cursor: 0 }).terminal.map((event) => event.state)).toEqual(['expired'])
    expect(calls).toHaveLength(0)
  })

  it('rejects changed pending bytes, bad signature, unknown key, principal and surface without consuming pending', async () => {
    const execution = authority.submit({ owner: owner, submitted: submitted() })
    const pending = authority.pending({ signer: signer, id: execution.executionId })
    const valid = decision({ pending: pending, optionId: 'allow-once' })
    const changedReview = {
      ...pending.payload,
      review: { ...pending.payload.review, account: 'wrong-account' },
    }
    const invalid = [
      Protocol.signPayload({ domain: 'decision', payload: { ...valid.payload, pendingDigest: Protocol.digest(changedReview) }, keyId: signer.keyId, key: signerKeys.privateKey }),
      Protocol.signPayload({ domain: 'decision', payload: valid.payload, keyId: signer.keyId, key: otherKeys.privateKey }),
      Protocol.signPayload({ domain: 'decision', payload: valid.payload, keyId: 'unknown-key', key: signerKeys.privateKey }),
      Protocol.signPayload({ domain: 'decision', payload: { ...valid.payload, principalId: 'someone-else' }, keyId: signer.keyId, key: signerKeys.privateKey }),
      Protocol.signPayload({ domain: 'decision', payload: { ...valid.payload, surfaceId: 'another-surface' }, keyId: signer.keyId, key: signerKeys.privateKey }),
      Protocol.signPayload({ domain: 'decision', payload: { ...valid.payload, decidedAt: time + 1 }, keyId: signer.keyId, key: signerKeys.privateKey }),
      Protocol.signPayload({ domain: 'decision', payload: { ...valid.payload, optionId: 'allow-for-session' }, keyId: signer.keyId, key: signerKeys.privateKey }),
    ]
    for (const input of invalid) {
      await expect(authority.decide(input)).rejects.toBeInstanceOf(AuthorityError)
      expect(authority.pending({ signer: signer, id: execution.executionId }).payload).toEqual(pending.payload)
    }
    expect(calls).toHaveLength(0)
    await authority.decide(valid)
    await authority.drain()
    expect(calls).toHaveLength(1)
  })

  it('atomically reserves before dispatch, concurrent duplicate clicks execute once, and outbox replay is durable', async () => {
    const completion = Promise.withResolvers<ExecutorResult>()
    authority.close()
    open(async (dispatch) => {
      calls.push(dispatch)
      expect(authority.status({ owner: owner, id: dispatch.payload.executionId }).state).toBe('reserved')
      return await completion.promise
    })
    const input = submitted()
    const execution = authority.submit({ owner: owner, submitted: input })
    expect(authority.submit({ owner: owner, submitted: input }).executionId).toBe(execution.executionId)
    expect(() =>
      authority.submit({ owner: owner, submitted: { ...input, claimed: { ...input.claimed, intent: 'changed' } } }),
    ).toThrow('idempotency-conflict')
    const signed = decision({ pending: authority.pending({ signer: signer, id: execution.executionId }), optionId: 'allow-once' })
    const results = await Promise.all(Array.from({ length: 12 }, () => authority.decide(signed)))
    expect(results.every((result) => result.state === 'reserved')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(authority.sync({ signer: signer, cursor: 0 }).terminal.map((event) => event.state)).toEqual(['reserved'])
    completion.resolve({ state: 'succeeded', result: 'private-calendar-result' })
    await authority.drain()
    const result = authority.status({ owner: owner, id: execution.executionId })
    expect(result.state).toBe('succeeded')
    expect(result.resultDigest).toBe(Protocol.digest('private-calendar-result'))
    expect(result.decisionDigest).toBe(Protocol.digest(signed))
    const signerReceipt = authority.signerStatus({ signer: signer, id: execution.executionId })
    expect(signerReceipt.decisionDigest).toBe(Protocol.digest(signed))
    expect(signerReceipt.result).toBeUndefined()
    const cursor = authority.sync({ signer: signer, cursor: 0 }).cursor
    authority.close()
    open()
    expect(authority.sync({ signer: signer, cursor: 0 }).terminal.map((event) => event.state)).toEqual([
      'reserved',
      'succeeded',
    ])
    expect(authority.sync({ signer: signer, cursor: cursor }).terminal).toEqual([])
    const replayedDecision = await authority.decide(signed)
    expect(replayedDecision.result).toBeUndefined()
    expect(replayedDecision.resultDigest).toBe(Protocol.digest('private-calendar-result'))
    expect(authority.status({ owner: owner, id: execution.executionId }).result).toBe('private-calendar-result')
    await authority.drain()
    const losingClick = Protocol.signPayload({ domain: 'decision', payload: { ...signed.payload, optionId: 'deny' }, keyId: signer.keyId, key: signerKeys.privateKey })
    expect((await authority.decide(losingClick)).decisionDigest).toBe(Protocol.digest(signed))
    expect(calls).toHaveLength(1)
  })

  it('binds signed dispatch to the admitted command and account and rejects modified dispatch bytes', async () => {
    const execution = authority.submit({ owner: owner, submitted: submitted() })
    await authority.decide(decision({ pending: authority.pending({ signer: signer, id: execution.executionId }), optionId: 'allow-once' }))
    await authority.drain()
    const dispatch = calls[0]
    expect(dispatch).toBeDefined()
    if (dispatch === undefined) throw new AuthorityError({ code: 'missing-dispatch' })
    expect(dispatch.payload.action).toEqual(action)
    expect(dispatch.payload.catalogDigest).toBe(Protocol.digest(catalog))
    expect(dispatch.payload.actionDigest).toBe(
      Protocol.digestAction({ catalogDigest: Protocol.digest(catalog), action: action }),
    )
    expect(
      Protocol.digestAction({ catalogDigest: Protocol.digest({ ...catalog, revision: 'different-semantics' }), action: action }),
    ).not.toBe(dispatch.payload.actionDigest)
    expect(dispatch.payload.requestDigest).toBe(execution.requestDigest)
    for (const changed of [
      { ...action, account: 'other-account' },
      { ...action, commandId: 'calendar.delete' },
    ]) {
      const tampered = { ...dispatch, payload: { ...dispatch.payload, action: changed } }
      expect(Protocol.verifyPayload({ domain: 'dispatch', envelope: tampered, key: authorityKeys.publicKey })).toBe(false)
      const reSigned = Protocol.signPayload({ domain: 'dispatch', payload: tampered.payload, keyId: 'authority-key', key: authorityKeys.privateKey })
      expect(
        Protocol.digestAction({ catalogDigest: reSigned.payload.catalogDigest, action: reSigned.payload.action }),
      ).not.toBe(reSigned.payload.actionDigest)
    }
    expect(() =>
      authority.submit({ owner: owner, submitted: { ...submitted(), action: { ...action, account: 'other-account' } } }),
    ).toThrow('invalid-action')
    expect(() =>
      authority.submit({ owner: owner, submitted: {
        ...submitted(),
        action: { ...action, commandId: 'calendar.delete' },
      } }),
    ).toThrow('invalid-action')
  })

  it('restores pending on disk with the same identity and never resends reserved after restart', async () => {
    const input = submitted()
    const execution = authority.submit({ owner: owner, submitted: input })
    const before = authority.pending({ signer: signer, id: execution.executionId })
    const interrupted = Promise.withResolvers<ExecutorResult>()
    authority.close()
    open(async (dispatch) => {
      calls.push(dispatch)
      return await interrupted.promise
    })
    expect(authority.pending({ signer: signer, id: execution.executionId })).toEqual(before)
    expect(authority.submit({ owner: owner, submitted: input }).executionId).toBe(execution.executionId)
    const signed = decision({ pending: before, optionId: 'allow-once' })
    await authority.decide(signed)
    expect(calls).toHaveLength(1)
    authority.close()
    open()
    expect(authority.status({ owner: owner, id: execution.executionId }).state).toBe('unknown')
    expect((await authority.decide(signed)).state).toBe('unknown')
    await authority.drain()
    expect(calls).toHaveLength(1)
    expect(authority.sync({ signer: signer, cursor: 0 }).terminal.map((event) => event.state)).toEqual([
      'reserved',
      'unknown',
    ])
    interrupted.resolve({ state: 'succeeded', result: 'late-completion' })
    await Promise.resolve()
    expect(authority.status({ owner: owner, id: execution.executionId }).state).toBe('unknown')
  })

  it('marks executor failures ambiguous, but preserves explicit failed and unknown outcomes', async () => {
    for (const state of ['failed', 'unknown', 'throws'] as const) {
      authority.close()
      open(async () => {
        if (state === 'throws') throw new AuthorityError({ code: 'provider-disconnected' })
        return { state, result: 'provider-outcome' }
      })
      const execution = authority.submit({ owner: owner, submitted: submitted() })
      await authority.decide(
        decision({ pending: authority.pending({ signer: signer, id: execution.executionId }), optionId: 'allow-once' }),
      )
      await authority.drain()
      expect(authority.status({ owner: owner, id: execution.executionId }).state).toBe(
        state === 'throws' ? 'unknown' : state,
      )
    }
  })

  it('never downgrades sensitivity from the private catalog or caller claim', () => {
    authority.close()
    const admitLow = (input: Protocol.Action) => ({
      action: input,
      fields: [],
      sensitivity: 'low' as const,
    })
    options = { ...options, catalog: { catalog, admit: admitLow } }
    open()
    expect(() => authority.submit({ owner: owner, submitted: submitted() })).toThrow('invalid-admission')
    authority.close()
    const lowCatalog: Protocol.Catalog = {
      ...catalog,
      entries: catalog.entries.map((entry) => ({
        commandId: entry.commandId,
        sensitivity: 'low',
        description: entry.description,
        accounts: entry.accounts,
        argsSchema: entry.argsSchema,
      })),
    }
    options = { ...options, catalog: { catalog: lowCatalog, admit: admitLow } }
    open()
    const input: Protocol.Submitted = {
      ...submitted(),
      catalogDigest: Protocol.digest(lowCatalog),
      claimed: { intent: 'Caller explicitly marks this sensitive', sensitivity: 'sensitive' },
    }
    const execution = authority.submit({ owner: owner, submitted: input })
    expect(authority.pending({ signer: signer, id: execution.executionId }).payload.review.sensitivity).toBe(
      'sensitive',
    )
  })

  it('scopes idempotency and status by both owner identity and pinned key', () => {
    const second: Protocol.Owner = { identity: owner.identity, keyId: 'second-caller-key' }
    authority.close()
    options = {
      ...options,
      callers: [...options.callers, { ...second, publicKey: otherKeys.publicKey }],
    }
    open()
    const input = submitted('shared-key')
    const first = authority.submit({ owner: owner, submitted: input })
    const secondExecution = authority.submit({ owner: second, submitted: input })
    expect(secondExecution.executionId).not.toBe(first.executionId)
    expect(() => authority.status({ owner: second, id: first.executionId })).toThrow('not-found')
    expect(() => authority.submit({ owner: { ...owner, identity: 'other-owner' }, submitted: input })).toThrow(
      'unauthorized-owner',
    )
    expect(() =>
      authority.pending({ signer: { ...signer, principalId: 'other-human' }, id: first.executionId }),
    ).toThrow('unauthorized-signer')
  })
})

describe('signed authenticated HTTP adapter', () => {
  it('binds method/path/body, persists nonce replay prevention across restart, and enforces caller/signer route separation', async () => {
    let handler = createHttpHandler(authority)
    const input = submitted()
    const original = request({ path: '/v1/submit', method: 'POST', body: input })
    const replay = original.clone()
    const first = await handler(original)
    expect(first.status).toBe(200)
    const execution = Protocol.decodeJson({ schema: Protocol.Status, text: await first.text() })
    authority.close()
    open()
    handler = createHttpHandler(authority)
    expect((await handler(replay)).status).toBe(401)
    expect(
      (await handler(request({ path: `/v1/pending/${execution.executionId}`, method: 'GET', body: null }))).status,
    ).toBe(403)
    expect(
      (
        await handler(
          request({ path: `/v1/status/${execution.executionId}`, method: 'GET', body: null, keyId: signer.keyId, key: signerKeys.privateKey }),
        )
      ).status,
    ).toBe(200)
    const pendingResponse = await handler(
      request({ path: `/v1/pending/${execution.executionId}`, method: 'GET', body: null, keyId: signer.keyId, key: signerKeys.privateKey }),
    )
    const pending = Protocol.decodeJson({ schema: Protocol.SignedPending, text: await pendingResponse.text() })
    const signed = decision({ pending: pending, optionId: 'deny' })
    expect(
      (await handler(request({ path: '/v1/decision', method: 'POST', body: signed, keyId: signer.keyId, key: signerKeys.privateKey })))
        .status,
    ).toBe(200)
    const sync = await handler(
      request({ path: '/v1/sync?cursor=0', method: 'GET', body: null, keyId: signer.keyId, key: signerKeys.privateKey }),
    )
    expect(
      Protocol.decodeJson({ schema: Protocol.Sync, text: await sync.text() }).terminal.map((event) => event.state),
    ).toEqual(['denied'])
    const changedBody = request({ path: '/v1/submit', method: 'POST', body: input })
    expect(
      (
        await handler(
          new Request(changedBody.url, {
            method: 'POST',
            headers: changedBody.headers,
            body: JSON.stringify({ ...input, idempotencyKey: 'changed' }),
          }),
        )
      ).status,
    ).toBe(401)
    const changedPath = request({ path: '/v1/catalog', method: 'GET', body: null })
    expect(
      (
        await handler(
          new Request('http://authority.test/v1/sync', { headers: changedPath.headers }),
        )
      ).status,
    ).toBe(401)
    const old = request({ path: '/v1/catalog', method: 'GET', body: null })
    time += 60_001
    expect((await handler(old)).status).toBe(401)
  })

  it('rejects duplicate JSON properties, unknown schema fields, missing and wrong auth; health is public and uncacheable', async () => {
    const handler = createHttpHandler(authority)
    expect((await handler(new Request('http://authority.test/v1/catalog'))).status).toBe(401)
    expect(
      (await handler(request({ path: '/v1/catalog', method: 'GET', body: null, keyId: owner.keyId, key: otherKeys.privateKey })))
        .status,
    ).toBe(401)
    const input = submitted()
    const signedRequest = request({ path: '/v1/submit', method: 'POST', body: input })
    const duplicate = `{"action":null,${JSON.stringify(input).slice(1)}`
    expect(
      (
        await handler(
          new Request(signedRequest.url, {
            method: 'POST',
            headers: signedRequest.headers,
            body: duplicate,
          }),
        )
      ).status,
    ).toBe(400)
    const extra = { ...input, untrustedExtra: true }
    expect((await handler(request({ path: '/v1/submit', method: 'POST', body: extra }))).status).toBe(400)
    const nonce = randomUUID()
    const health = await handler(new Request(`http://authority.test/health?nonce=${nonce}`))
    expect(health.status).toBe(200)
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(Protocol.decodeJson({ schema: Protocol.Health, text: await health.text() }).nonce).toBe(nonce)
  })
})
