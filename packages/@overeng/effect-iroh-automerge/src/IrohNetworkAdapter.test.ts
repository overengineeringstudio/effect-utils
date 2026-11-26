import { cbor, type Message, type PeerId } from '@automerge/automerge-repo'
import { Effect, Fiber } from 'effect'
import { describe, expect, it } from 'vitest'

import { connPair } from '@overeng/effect-iroh-browser/testing'

import { IrohNetworkAdapter, remotePeers } from './IrohNetworkAdapter.ts'

const A = 'aaaa'
const B = 'bbbb'
const peer = (device: string) => `${device}-tab1` as PeerId

const adapter = (endpointId: string) => {
  const a = new IrohNetworkAdapter(endpointId)
  a.connect(peer(endpointId))
  const events: Array<{ type: string; peerId?: PeerId; msg?: Message }> = []
  a.on('peer-candidate', ({ peerId }) => events.push({ type: 'candidate', peerId }))
  a.on('peer-disconnected', ({ peerId }) => events.push({ type: 'disconnected', peerId }))
  a.on('message', (msg) => events.push({ type: 'message', msg }))
  return { adapter: a, events }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe('IrohNetworkAdapter', () => {
  it('handshakes and stamps messages with the connection-proven peer', async () => {
    const a = adapter(A)
    const b = adapter(B)
    const [atA, atB] = connPair({ a: A, b: B })
    void a.adapter.addConnection({ conn: atA, outgoing: true })
    void b.adapter.addConnection({ conn: atB, outgoing: false })
    await settle()

    expect(a.events).toEqual([{ type: 'candidate', peerId: peer(B) }])
    expect(b.events).toEqual([{ type: 'candidate', peerId: peer(A) }])
    expect([...a.adapter.connectedEndpoints]).toEqual([B])
    expect(remotePeers.has(peer(B))).toBe(true)

    // A forged senderId is replaced by the peer bound to the connection.
    await atB.send(
      cbor.encode({
        type: 'sync',
        senderId: 'evil-1',
        targetId: peer(A),
        documentId: 'd',
        data: new Uint8Array(),
      }),
    )
    // Messages for someone else are ignored.
    await atB.send(
      cbor.encode({ type: 'sync', senderId: peer(B), targetId: 'other-1', documentId: 'd' }),
    )
    await settle()
    const messages = a.events.filter((e) => e.type === 'message')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.msg!.senderId).toBe(peer(B))

    atB.close()
    await settle()
    expect(a.events.at(-1)).toEqual({ type: 'disconnected', peerId: peer(B) })
    expect(a.adapter.hasLink(B)).toBe(false)
    expect(remotePeers.has(peer(B))).toBe(false)
  })

  it('keeps the connection dialed by the lower endpoint id on both sides', async () => {
    const a = adapter(A) // lower id
    const b = adapter(B)
    const [aDialed, bAcceptedFromA] = connPair({ a: A, b: B })
    const [bDialed, aAcceptedFromB] = connPair({ a: B, b: A })
    // Both sides dial at once; each sees its own outgoing and the other's incoming connection.
    void a.adapter.addConnection({ conn: aDialed, outgoing: true })
    void b.adapter.addConnection({ conn: bDialed, outgoing: true })
    void a.adapter.addConnection({ conn: aAcceptedFromB, outgoing: false })
    void b.adapter.addConnection({ conn: bAcceptedFromA, outgoing: false })
    await settle()

    expect(aDialed.closed).toBe(false)
    expect(bAcceptedFromA.closed).toBe(false)
    expect(bDialed.closed).toBe(true)
    expect(aAcceptedFromB.closed).toBe(true)
    expect([...a.adapter.connectedEndpoints]).toEqual([B])
    expect([...b.adapter.connectedEndpoints]).toEqual([A])
  })

  it('drops a peer that claims another device', async () => {
    const a = adapter(A)
    const [atA, atB] = connPair({ a: A, b: B })
    void a.adapter.addConnection({ conn: atA, outgoing: true })
    await atB.send(
      cbor.encode({ type: 'games-hello', v: 1, senderId: 'cccc-tab1', peerMetadata: {} }),
    )
    await settle()
    expect(a.events).toEqual([])
    expect(atA.closed).toBe(true)
    expect(a.adapter.hasLink(B)).toBe(false)
  })

  it('waits for the repo before saying hello', async () => {
    const a = new IrohNetworkAdapter(A)
    const [atA] = connPair({ a: A, b: B })
    void a.addConnection({ conn: atA, outgoing: true })
    await settle()
    expect(atA.sent).toHaveLength(0)
    a.connect(peer(A))
    await settle()
    expect(atA.sent).toHaveLength(1)
  })

  it('closes the connection when its fiber is interrupted', async () => {
    const a = adapter(A)
    const [atA] = connPair({ a: A, b: B })
    const fiber = Effect.runFork(a.adapter.runConnection({ conn: atA, outgoing: true }))
    await settle()
    expect(a.adapter.hasLink(B)).toBe(true)
    await Effect.runPromise(Fiber.interrupt(fiber))
    expect(atA.closed).toBe(true)
    expect(a.adapter.hasLink(B)).toBe(false)
  })

  it('awaitNoLink completes once the link is gone', async () => {
    const a = adapter(A)
    await Effect.runPromise(a.adapter.awaitNoLink(B)) // no link: immediately
    const [atA] = connPair({ a: A, b: B })
    void a.adapter.addConnection({ conn: atA, outgoing: true })
    await settle()
    const waiting = Effect.runPromise(a.adapter.awaitNoLink(B))
    let done = false
    void waiting.then(() => (done = true))
    await settle()
    expect(done).toBe(false)
    atA.close()
    await waiting
  })

  it('authenticates ephemeral senders without discarding their payload', async () => {
    const a = adapter(A)
    const [atA, atB] = connPair({ a: A, b: B })
    const fiber = Effect.runFork(a.adapter.runConnection({ conn: atA, outgoing: true }))
    try {
      await atB.send(
        cbor.encode({
          type: 'games-hello',
          v: 1,
          senderId: peer(B),
          peerMetadata: {},
        }),
      )
      const payload = new Uint8Array([1, 2, 3])
      await atB.send(
        cbor.encode({
          type: 'ephemeral',
          senderId: 'cccc-forged',
          targetId: peer(A),
          documentId: 'presence',
          data: payload,
          count: 1,
          sessionId: 'session',
        }),
      )
      await settle()
      const messages = a.events.filter((event) => event.type === 'message')
      expect(messages).toHaveLength(1)
      const message = messages[0]!.msg
      expect(message).toMatchObject({ type: 'ephemeral', senderId: peer(B) })
      if (message?.type !== 'ephemeral' || !(message.data instanceof Uint8Array))
        throw new Error('Expected an ephemeral byte payload')
      // Node CBOR decodes byte strings as Buffer, browsers as Uint8Array: compare every byte.
      expect(Array.from(message.data)).toEqual(Array.from(payload))
    } finally {
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  })
})
