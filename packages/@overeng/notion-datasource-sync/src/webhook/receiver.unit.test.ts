import { afterEach, describe, expect, it } from 'vitest'

import { makeStoreFixture, testIds } from '../testing/harness.ts'
import { computeNotionWebhookSignature } from './notion.ts'
import { startNotionWebhookReceiver, startNotionWebhookReceiverRuntime } from './receiver.ts'
import type { WebhookRelayProvider } from './tailscale.ts'

const verificationToken = 'receiver-verification-token'

const receiverFixtures: Array<{ readonly cleanup: () => void | Promise<void> }> = []

afterEach(async () => {
  const cleanups = receiverFixtures.splice(0).toReversed()
  await cleanups.reduce(
    (previous, fixture) => previous.then(async () => fixture.cleanup()),
    Promise.resolve(),
  )
})

describe('Notion webhook receiver', () => {
  it('persists signed Notion events into the durable signal inbox wake source', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    receiverFixtures.push(storeFixture)
    const receiver = await startNotionWebhookReceiver({
      rootId: testIds.rootId,
      store: storeFixture.store,
      verificationToken,
      path: '/notion/webhook',
    })
    receiverFixtures.push({ cleanup: () => receiver.close() })

    const rawBody = JSON.stringify({
      id: 'event-page-created',
      type: 'page.created',
      timestamp: '2026-05-29T08:00:00.000Z',
      entity: { id: testIds.pageId, type: 'page' },
      data: { parent: { data_source_id: testIds.dataSourceId } },
      raw_secret_like_field: 'do-not-persist',
    })
    const response = await fetch(receiver.url, {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-notion-signature': computeNotionWebhookSignature({ rawBody, verificationToken }),
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, inserted: true })
    expect(storeFixture.store.readSignalStatus(testIds.rootId)).toEqual({
      pending: 1,
      claimed: 0,
      processed: 0,
      failed: 0,
    })
    const [signal] = storeFixture.store.readSignals(testIds.rootId)
    expect(signal).toMatchObject({
      signalId: 'webhook:notion:event-page-created',
      provider: 'notion-webhook',
      externalId: 'notion:event-page-created',
      kind: 'remote-change',
      dataSourceId: testIds.dataSourceId,
      pageId: testIds.pageId,
      state: 'pending',
    })
    expect(signal?.payloadJson).toContain('page.created')
    expect(signal?.payloadJson).not.toContain('do-not-persist')
  })

  it('captures verification tokens and then accepts signed deliveries with that token', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    receiverFixtures.push(storeFixture)
    const receiver = await startNotionWebhookReceiver({
      rootId: testIds.rootId,
      store: storeFixture.store,
      path: '/notion/webhook',
    })
    receiverFixtures.push({ cleanup: () => receiver.close() })

    const verifyResponse = await fetch(receiver.url, {
      method: 'POST',
      body: JSON.stringify({ verification_token: verificationToken }),
      headers: { 'content-type': 'application/json' },
    })
    expect(verifyResponse.status).toBe(200)
    expect(receiver.getVerificationToken()).toBe(verificationToken)
    expect(receiver.status().verificationConfigured).toBe(true)

    const resetResponse = await fetch(receiver.url, {
      method: 'POST',
      body: JSON.stringify({ verification_token: 'attacker-token' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(resetResponse.status).toBe(401)
    expect(receiver.getVerificationToken()).toBe(verificationToken)

    const rawBody = JSON.stringify({
      id: 'event-after-verification',
      type: 'data_source.schema_updated',
      entity: { id: testIds.dataSourceId, type: 'data_source' },
    })
    const eventResponse = await fetch(receiver.url, {
      method: 'POST',
      body: rawBody,
      headers: {
        'content-type': 'application/json',
        'x-notion-signature': computeNotionWebhookSignature({ rawBody, verificationToken }),
      },
    })

    expect(eventResponse.status).toBe(200)
    expect(storeFixture.store.readSignalStatus(testIds.rootId).pending).toBe(1)
  })

  it('exposes dynamic status and has an idempotent finalizer', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    receiverFixtures.push(storeFixture)
    const receiver = await startNotionWebhookReceiver({
      rootId: testIds.rootId,
      store: storeFixture.store,
      path: '/notion/webhook',
    })
    receiverFixtures.push({ cleanup: () => receiver.close() })

    expect(receiver.status()).toMatchObject({
      closed: false,
      localTarget: `localhost:${receiver.port.toString()}`,
      path: '/notion/webhook',
    })

    const verifyResponse = await fetch(receiver.url, {
      method: 'POST',
      body: JSON.stringify({ verification_token: verificationToken }),
      headers: { 'content-type': 'application/json' },
    })
    expect(verifyResponse.status).toBe(200)
    expect(receiver.status().verificationConfigured).toBe(true)

    await receiver.close()
    await receiver.close()
    expect(receiver.status().closed).toBe(true)
  })

  it('starts and stops relay providers around the receiver lifecycle', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    receiverFixtures.push(storeFixture)
    const calls: string[] = []
    const runtime = await startNotionWebhookReceiverRuntime({
      rootId: testIds.rootId,
      store: storeFixture.store,
      path: '/notion/webhook',
      makeRelayProvider: (receiver): WebhookRelayProvider => ({
        kind: 'manual',
        start: async () => {
          calls.push(`start:${receiver.localTarget}:${receiver.path}`)
          return {
            provider: 'manual',
            publicUrl: `https://example.test${receiver.path}`,
            localTarget: receiver.localTarget,
            path: receiver.path,
          }
        },
        status: async () => ({
          _tag: 'running',
          exposure: {
            provider: 'manual',
            publicUrl: `https://example.test${receiver.path}`,
            localTarget: receiver.localTarget,
            path: receiver.path,
          },
        }),
        stop: async () => {
          calls.push('stop')
        },
      }),
    })
    receiverFixtures.push({ cleanup: () => runtime.close() })

    expect(runtime.relayExposure).toMatchObject({
      provider: 'manual',
      localTarget: runtime.receiver.localTarget,
      path: '/notion/webhook',
    })
    expect(calls).toEqual([`start:${runtime.receiver.localTarget}:/notion/webhook`])

    await runtime.close()
    await runtime.close()
    expect(calls).toEqual([`start:${runtime.receiver.localTarget}:/notion/webhook`, 'stop'])
    expect(runtime.status().receiver.closed).toBe(true)
  })

  it('closes the receiver if relay startup fails', async () => {
    const storeFixture = makeStoreFixture({ mode: 'memory' })
    receiverFixtures.push(storeFixture)
    let receiverUrl = ''

    await expect(
      startNotionWebhookReceiverRuntime({
        rootId: testIds.rootId,
        store: storeFixture.store,
        path: '/notion/webhook',
        makeRelayProvider: (receiver): WebhookRelayProvider => ({
          kind: 'manual',
          start: async () => {
            receiverUrl = receiver.url
            throw new Error('relay failed')
          },
          status: async () => ({ _tag: 'not-running', provider: 'manual', reason: 'failed' }),
          stop: async () => {},
        }),
      }),
    ).rejects.toThrow('relay failed')

    await expect(
      fetch(receiverUrl, {
        method: 'POST',
        body: JSON.stringify({ verification_token: verificationToken }),
        headers: { 'content-type': 'application/json' },
      }),
    ).rejects.toThrow()
  })
})
