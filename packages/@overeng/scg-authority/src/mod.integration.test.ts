import { Database } from 'bun:sqlite'
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as Protocol from '@overeng/scg-protocol'
import { AuthorityError, createAuthority, createHttpHandler, type Authority, type AuthorityOptions, type ExecutorResult } from './mod.ts'

const authorityKeys = generateKeyPairSync('ed25519')
const signerKeys = generateKeyPairSync('ed25519')
const callerKeys = generateKeyPairSync('ed25519')
const otherKeys = generateKeyPairSync('ed25519')
const owner: Protocol.Owner = { identity: 'agent', keyId: 'caller-key' }
const signer = { keyId: 'signer-key', principalId: 'human', surfaceId: 'review-ui' }
const catalog: Protocol.Catalog = { epoch: 'scg-experiment-v1', revision: 'test-1', entries: [
  { commandId: 'calendar.list', sensitivity: 'sensitive', description: 'List test calendar', accounts: ['test-account'], argsSchema: { type: 'object' } },
] }
const action: Protocol.Action = { commandId: 'calendar.list', account: 'test-account', args: { from: '2026-11-18' } }
const submitted = (idempotencyKey = randomUUID()): Protocol.Submitted => ({
  epoch: 'scg-experiment-v1', catalogDigest: Protocol.digest(catalog), idempotencyKey, action,
  claimed: { intent: 'Read the calendar for planning', sensitivity: 'low' },
})
const decision = (pending: Protocol.SignedPending, optionId: 'allow-once' | 'deny', decidedAt = pending.payload.issuedAt): Protocol.SignedDecision => Protocol.signPayload('decision', {
  epoch: 'scg-experiment-v1', kind: 'decision', executionId: pending.payload.executionId,
  pendingDigest: Protocol.digest(pending.payload), optionId, principalId: signer.principalId, surfaceId: signer.surfaceId, decidedAt,
}, signer.keyId, signerKeys.privateKey)

let directory: string
let time: number
let authority: Authority
let options: AuthorityOptions
let calls: Protocol.SignedDispatch[]
const open = (executor?: AuthorityOptions['executor']): Authority => {
  authority = createAuthority({ ...options, ...(executor === undefined ? {} : { executor }) })
  return authority
}
beforeEach(async () => {
  const root = fileURLToPath(new URL('../../../../tmp/scg-authority-tests/', import.meta.url))
  await mkdir(root, { recursive: true })
  directory = await mkdtemp(`${root}case-`)
  time = 1_800_000_000_000
  calls = []
  options = {
    dbPath: `${directory}/authority.sqlite`, authority: { keyId: 'authority-key', privateKey: authorityKeys.privateKey },
    signers: [{ ...signer, publicKey: signerKeys.publicKey }], callers: [{ ...owner, publicKey: callerKeys.publicKey }],
    audience: 'local-test-executor', release: 'integration', now: () => time, pendingTtlMs: 1_000,
    catalog: { catalog, admit: (input) => {
      if (input.commandId !== action.commandId || input.account !== action.account || typeof input.args.from !== 'string') throw new AuthorityError('invalid-action')
      return { action: input, fields: [{ label: 'From', value: input.args.from }], sensitivity: 'sensitive' }
    } },
    executor: async (dispatch) => {
      calls.push(dispatch)
      if (!Protocol.verifyPayload('dispatch', dispatch, authorityKeys.publicKey) ||
        Protocol.digest(dispatch.payload.action) !== dispatch.payload.actionDigest ||
        dispatch.payload.audience !== 'local-test-executor' || dispatch.payload.deadline <= time) throw new AuthorityError('invalid-dispatch')
      return { state: 'succeeded', result: 'test-calendar-output' }
    },
  }
  open()
})
afterEach(async () => { authority.close(); await rm(directory, { recursive: true, force: true }) })

const request = (path: string, method: 'GET' | 'POST', body: unknown, keyId = owner.keyId, key: KeyObject = callerKeys.privateKey): Request => {
  const auth = Protocol.signPayload('auth-request', {
    epoch: 'scg-experiment-v1', method, path, bodyDigest: Protocol.digest(body), nonce: randomUUID(), issuedAt: time,
  }, keyId, key)
  return new Request(`http://authority.test${path}`, { method, headers: { 'x-scg-auth': JSON.stringify(auth) },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) })
}

describe('durable exact-grant authority', () => {
  it('denies without dispatch and exposes terminal outbox without private payloads', async () => {
    const execution = authority.submit(owner, submitted())
    const pending = authority.pending(signer, execution.executionId)
    expect(pending.payload.review.sensitivity).toBe('sensitive')
    expect(pending.payload.review.agentClaim).toBe('Read the calendar for planning')
    expect(Protocol.verifyPayload('pending', pending, authorityKeys.publicKey)).toBe(true)
    expect((await authority.decide(decision(pending, 'deny'))).state).toBe('denied')
    await authority.drain()
    expect(calls).toHaveLength(0)
    const sync = authority.sync(signer, 0)
    expect(sync.pending).toHaveLength(0)
    expect(sync.terminal.map((event) => event.state)).toEqual(['denied'])
    const db = new Database(options.dbPath, { readonly: true })
    try {
      const audit = db.query<{ digest: string }, []>('SELECT digest FROM audit').all()
      expect(audit.length).toBeGreaterThan(0)
      expect(audit.every((entry) => /^sha256:[a-f0-9]{64}$/.test(entry.digest))).toBe(true)
      const columns = db.query<{ name: string }, []>('PRAGMA table_info(audit)').all().map((column) => column.name)
      expect(columns).toEqual(['sequence', 'digest'])
    } finally { db.close() }
  })

  it('expires without spending a grant and persists the terminal transition', async () => {
    const execution = authority.submit(owner, submitted())
    const pending = authority.pending(signer, execution.executionId)
    time += 1_000
    expect((await authority.decide(decision(pending, 'allow-once'))).state).toBe('expired')
    authority.close(); open()
    expect(authority.status(owner, execution.executionId).state).toBe('expired')
    expect(authority.sync(signer, 0).terminal.map((event) => event.state)).toEqual(['expired'])
    expect(calls).toHaveLength(0)
  })

  it('rejects changed pending bytes, bad signature, unknown key, principal and surface without consuming pending', async () => {
    const execution = authority.submit(owner, submitted())
    const pending = authority.pending(signer, execution.executionId)
    const valid = decision(pending, 'allow-once')
    const changedReview = { ...pending.payload, review: { ...pending.payload.review, account: 'wrong-account' } }
    const invalid = [
      Protocol.signPayload('decision', { ...valid.payload, pendingDigest: Protocol.digest(changedReview) }, signer.keyId, signerKeys.privateKey),
      Protocol.signPayload('decision', valid.payload, signer.keyId, otherKeys.privateKey),
      Protocol.signPayload('decision', valid.payload, 'unknown-key', signerKeys.privateKey),
      Protocol.signPayload('decision', { ...valid.payload, principalId: 'someone-else' }, signer.keyId, signerKeys.privateKey),
      Protocol.signPayload('decision', { ...valid.payload, surfaceId: 'another-surface' }, signer.keyId, signerKeys.privateKey),
      Protocol.signPayload('decision', { ...valid.payload, decidedAt: time + 1 }, signer.keyId, signerKeys.privateKey),
      Protocol.signPayload('decision', { ...valid.payload, optionId: 'allow-for-session' }, signer.keyId, signerKeys.privateKey),
    ]
    for (const input of invalid) {
      await expect(authority.decide(input)).rejects.toBeInstanceOf(AuthorityError)
      expect(authority.pending(signer, execution.executionId).payload).toEqual(pending.payload)
    }
    expect(calls).toHaveLength(0)
    await authority.decide(valid); await authority.drain()
    expect(calls).toHaveLength(1)
  })

  it('atomically reserves before dispatch, concurrent duplicate clicks execute once, and outbox replay is durable', async () => {
    const completion = Promise.withResolvers<ExecutorResult>()
    authority.close()
    open(async (dispatch) => {
      calls.push(dispatch)
      expect(authority.status(owner, dispatch.payload.executionId).state).toBe('reserved')
      return await completion.promise
    })
    const input = submitted()
    const execution = authority.submit(owner, input)
    expect(authority.submit(owner, input).executionId).toBe(execution.executionId)
    expect(() => authority.submit(owner, { ...input, claimed: { ...input.claimed, intent: 'changed' } })).toThrow('idempotency-conflict')
    const signed = decision(authority.pending(signer, execution.executionId), 'allow-once')
    const results = await Promise.all(Array.from({ length: 12 }, () => authority.decide(signed)))
    expect(results.every((result) => result.state === 'reserved')).toBe(true)
    expect(calls).toHaveLength(1)
    expect(authority.sync(signer, 0).terminal.map((event) => event.state)).toEqual(['reserved'])
    completion.resolve({ state: 'succeeded', result: 'private-calendar-result' })
    await authority.drain()
    const result = authority.status(owner, execution.executionId)
    expect(result.state).toBe('succeeded')
    expect(result.resultDigest).toBe(Protocol.digest('private-calendar-result'))
    expect(result.decisionDigest).toBe(Protocol.digest(signed))
    const signerReceipt = authority.signerStatus(signer, execution.executionId)
    expect(signerReceipt.decisionDigest).toBe(Protocol.digest(signed))
    expect(signerReceipt.result).toBeUndefined()
    const cursor = authority.sync(signer, 0).cursor
    authority.close(); open()
    expect(authority.sync(signer, 0).terminal.map((event) => event.state)).toEqual(['reserved', 'succeeded'])
    expect(authority.sync(signer, cursor).terminal).toEqual([])
    await authority.decide(signed); await authority.drain()
    const losingClick = Protocol.signPayload('decision', { ...signed.payload, optionId: 'deny' }, signer.keyId, signerKeys.privateKey)
    expect((await authority.decide(losingClick)).decisionDigest).toBe(Protocol.digest(signed))
    expect(calls).toHaveLength(1)
  })

  it('binds signed dispatch to the admitted command and account and rejects modified dispatch bytes', async () => {
    const execution = authority.submit(owner, submitted())
    await authority.decide(decision(authority.pending(signer, execution.executionId), 'allow-once'))
    await authority.drain()
    const dispatch = calls[0]
    expect(dispatch).toBeDefined()
    if (dispatch === undefined) throw new AuthorityError('missing-dispatch')
    expect(dispatch.payload.action).toEqual(action)
    expect(dispatch.payload.actionDigest).toBe(Protocol.digest(action))
    expect(dispatch.payload.requestDigest).toBe(execution.requestDigest)
    for (const changed of [{ ...action, account: 'other-account' }, { ...action, commandId: 'calendar.delete' }]) {
      const tampered = { ...dispatch, payload: { ...dispatch.payload, action: changed } }
      expect(Protocol.verifyPayload('dispatch', tampered, authorityKeys.publicKey)).toBe(false)
      const reSigned = Protocol.signPayload('dispatch', tampered.payload, 'authority-key', authorityKeys.privateKey)
      expect(Protocol.digest(reSigned.payload.action)).not.toBe(reSigned.payload.actionDigest)
    }
    expect(() => authority.submit(owner, { ...submitted(), action: { ...action, account: 'other-account' } })).toThrow('invalid-action')
    expect(() => authority.submit(owner, { ...submitted(), action: { ...action, commandId: 'calendar.delete' } })).toThrow('invalid-action')
  })

  it('restores pending on disk with the same identity and never resends reserved after restart', async () => {
    const input = submitted()
    const execution = authority.submit(owner, input)
    const before = authority.pending(signer, execution.executionId)
    const interrupted = Promise.withResolvers<ExecutorResult>()
    authority.close(); open(async (dispatch) => { calls.push(dispatch); return await interrupted.promise })
    expect(authority.pending(signer, execution.executionId)).toEqual(before)
    expect(authority.submit(owner, input).executionId).toBe(execution.executionId)
    const signed = decision(before, 'allow-once')
    await authority.decide(signed)
    expect(calls).toHaveLength(1)
    authority.close(); open()
    expect(authority.status(owner, execution.executionId).state).toBe('unknown')
    expect((await authority.decide(signed)).state).toBe('unknown')
    await authority.drain()
    expect(calls).toHaveLength(1)
    expect(authority.sync(signer, 0).terminal.map((event) => event.state)).toEqual(['reserved', 'unknown'])
    interrupted.resolve({ state: 'succeeded', result: 'late-completion' })
    await Promise.resolve()
    expect(authority.status(owner, execution.executionId).state).toBe('unknown')
  })

  it('marks executor failures ambiguous, but preserves explicit failed and unknown outcomes', async () => {
    for (const state of ['failed', 'unknown', 'throws'] as const) {
      authority.close(); open(async () => {
        if (state === 'throws') throw new AuthorityError('provider-disconnected')
        return { state, result: 'provider-outcome' }
      })
      const execution = authority.submit(owner, submitted())
      await authority.decide(decision(authority.pending(signer, execution.executionId), 'allow-once'))
      await authority.drain()
      expect(authority.status(owner, execution.executionId).state).toBe(state === 'throws' ? 'unknown' : state)
    }
  })

  it('never downgrades sensitivity from the private catalog or caller claim', () => {
    authority.close()
    const admitLow = (input: Protocol.Action) => ({ action: input, fields: [], sensitivity: 'low' as const })
    options = { ...options, catalog: { catalog, admit: admitLow } }
    open()
    expect(() => authority.submit(owner, submitted())).toThrow('invalid-admission')
    authority.close()
    const lowCatalog: Protocol.Catalog = { ...catalog, entries: catalog.entries.map((entry) => ({ ...entry, sensitivity: 'low' })) }
    options = { ...options, catalog: { catalog: lowCatalog, admit: admitLow } }
    open()
    const input: Protocol.Submitted = { ...submitted(), catalogDigest: Protocol.digest(lowCatalog),
      claimed: { intent: 'Caller explicitly marks this sensitive', sensitivity: 'sensitive' } }
    const execution = authority.submit(owner, input)
    expect(authority.pending(signer, execution.executionId).payload.review.sensitivity).toBe('sensitive')
  })

  it('scopes idempotency and status by both owner identity and pinned key', () => {
    const second = { identity: owner.identity, keyId: 'second-caller-key', publicKey: otherKeys.publicKey }
    authority.close(); options = { ...options, callers: [...options.callers, second] }; open()
    const input = submitted('shared-key')
    const first = authority.submit(owner, input)
    const secondExecution = authority.submit(second, input)
    expect(secondExecution.executionId).not.toBe(first.executionId)
    expect(() => authority.status(second, first.executionId)).toThrow('not-found')
    expect(() => authority.submit({ ...owner, identity: 'other-owner' }, input)).toThrow('unauthorized-owner')
    expect(() => authority.pending({ ...signer, principalId: 'other-human' }, first.executionId)).toThrow('unauthorized-signer')
  })
})

describe('signed authenticated HTTP adapter', () => {
  it('binds method/path/body, persists nonce replay prevention across restart, and enforces caller/signer route separation', async () => {
    let handler = createHttpHandler(authority)
    const input = submitted()
    const original = request('/v1/submit', 'POST', input)
    const replay = original.clone()
    const first = await handler(original)
    expect(first.status).toBe(200)
    const execution = Protocol.decodeJson(Protocol.Status, await first.text())
    authority.close(); open(); handler = createHttpHandler(authority)
    expect((await handler(replay)).status).toBe(401)
    expect((await handler(request(`/v1/pending/${execution.executionId}`, 'GET', null))).status).toBe(403)
    expect((await handler(request(`/v1/status/${execution.executionId}`, 'GET', null, signer.keyId, signerKeys.privateKey))).status).toBe(200)
    const pendingResponse = await handler(request(`/v1/pending/${execution.executionId}`, 'GET', null, signer.keyId, signerKeys.privateKey))
    const pending = Protocol.decodeJson(Protocol.SignedPending, await pendingResponse.text())
    const signed = decision(pending, 'deny')
    expect((await handler(request('/v1/decision', 'POST', signed, signer.keyId, signerKeys.privateKey))).status).toBe(200)
    const sync = await handler(request('/v1/sync?cursor=0', 'GET', null, signer.keyId, signerKeys.privateKey))
    expect(Protocol.decodeJson(Protocol.Sync, await sync.text()).terminal.map((event) => event.state)).toEqual(['denied'])
    const changedBody = request('/v1/submit', 'POST', input)
    expect((await handler(new Request(changedBody.url, { method: 'POST', headers: changedBody.headers,
      body: JSON.stringify({ ...input, idempotencyKey: 'changed' }) }))).status).toBe(401)
    const changedPath = request('/v1/catalog', 'GET', null)
    expect((await handler(new Request('http://authority.test/v1/sync', { headers: changedPath.headers }))).status).toBe(401)
    const old = request('/v1/catalog', 'GET', null)
    time += 60_001
    expect((await handler(old)).status).toBe(401)
  })

  it('rejects duplicate JSON properties, unknown schema fields, missing and wrong auth; health is public and uncacheable', async () => {
    const handler = createHttpHandler(authority)
    expect((await handler(new Request('http://authority.test/v1/catalog'))).status).toBe(401)
    expect((await handler(request('/v1/catalog', 'GET', null, owner.keyId, otherKeys.privateKey))).status).toBe(401)
    const input = submitted()
    const signedRequest = request('/v1/submit', 'POST', input)
    const duplicate = `{"action":null,${JSON.stringify(input).slice(1)}`
    expect((await handler(new Request(signedRequest.url, { method: 'POST', headers: signedRequest.headers, body: duplicate }))).status).toBe(400)
    const extra = { ...input, untrustedExtra: true }
    expect((await handler(request('/v1/submit', 'POST', extra))).status).toBe(400)
    const nonce = randomUUID()
    const health = await handler(new Request(`http://authority.test/health?nonce=${nonce}`))
    expect(health.status).toBe(200)
    expect(health.headers.get('cache-control')).toBe('no-store')
    expect(Protocol.decodeJson(Protocol.Health, await health.text()).nonce).toBe(nonce)
  })
})
