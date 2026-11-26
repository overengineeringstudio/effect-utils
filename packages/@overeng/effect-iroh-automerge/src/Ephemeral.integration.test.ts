import {
  Repo,
  type DocHandle,
  type DocHandleEphemeralMessagePayload,
  type NetworkAdapter,
  type PeerId,
} from '@automerge/automerge-repo'
import { BroadcastChannelNetworkAdapter } from '@automerge/automerge-repo-network-broadcastchannel'
import { Effect, Fiber } from 'effect'
import { expect, it } from 'vitest'

import { connPair } from '@overeng/effect-iroh-browser/testing'

import { deviceIdOfPeer, IrohNetworkAdapter } from './IrohNetworkAdapter.ts'

const nextMessage = <T>(handle: DocHandle<T>): Promise<DocHandleEphemeralMessagePayload<T>> => {
  const next = Promise.withResolvers<DocHandleEphemeralMessagePayload<T>>()
  handle.once('ephemeral-message', next.resolve)
  return next.promise
}

const peerReady = (adapter: NetworkAdapter): Promise<void> => {
  const ready = Promise.withResolvers<void>()
  adapter.once('peer-candidate', () => ready.resolve())
  return ready.promise
}

it('forwards repo ephemeral presence across iroh and a local tab without losing remote identity', async () => {
  const channelName = crypto.randomUUID()
  const leaderAdapter = new IrohNetworkAdapter('aaaa')
  const remoteAdapter = new IrohNetworkAdapter('bbbb')
  const leaderLocal = new BroadcastChannelNetworkAdapter({ channelName, peerWaitMs: 0 })
  const tabLocal = new BroadcastChannelNetworkAdapter({ channelName, peerWaitMs: 0 })
  const ready = Promise.all([
    peerReady(leaderAdapter),
    peerReady(remoteAdapter),
    peerReady(leaderLocal),
    peerReady(tabLocal),
  ])
  const leader = new Repo({
    peerId: 'aaaa-leader' as PeerId,
    network: [leaderAdapter, leaderLocal],
  })
  const tab = new Repo({
    peerId: 'aaaa-tab' as PeerId,
    network: [tabLocal],
  })
  const remote = new Repo({ peerId: 'bbbb-remote' as PeerId, network: [remoteAdapter] })
  const [atLeader, atRemote] = connPair({ a: 'aaaa', b: 'bbbb' })
  const fibers = [
    Effect.runFork(leaderAdapter.runConnection({ conn: atLeader, outgoing: true })),
    Effect.runFork(remoteAdapter.runConnection({ conn: atRemote, outgoing: false })),
  ]
  try {
    // Lookup after transport discovery, not after a timing-dependent no-peer cutoff.
    await ready
    const remoteHandle = remote.create({ kind: 'presence-test' })
    // Repo may temporarily mark a document unavailable while peer share policies resolve.
    // Keep observing that same handle until real synchronization makes it ready.
    const leaderHandle = await leader.find<{ kind: string }>(remoteHandle.url, {
      allowableStates: ['ready', 'unavailable'],
    })
    await leaderHandle.whenReady()
    const tabHandle = await tab.find<{ kind: string }>(remoteHandle.url, {
      allowableStates: ['ready', 'unavailable'],
    })
    await tabHandle.whenReady()
    expect(leaderHandle.doc()).toEqual(remoteHandle.doc())
    expect(tabHandle.doc()).toEqual(remoteHandle.doc())
    const receivedAtTab = nextMessage(tabHandle)
    const receivedAtLeader = nextMessage(leaderHandle)
    const heartbeat = { deviceId: 'bbbb', activity: 'online' }
    remoteHandle.broadcast(heartbeat)
    const [atTab, atOwner] = await Promise.all([receivedAtTab, receivedAtLeader])
    expect(atTab.message).toEqual(heartbeat)
    expect(atOwner.message).toEqual(heartbeat)
    expect(atTab.senderId).toBe('bbbb-remote')
    expect(deviceIdOfPeer(atTab.senderId)).toBe(heartbeat.deviceId)

    const receivedAtRemote = nextMessage(remoteHandle)
    tabHandle.broadcast({ deviceId: 'aaaa', activity: 'online' })
    const fromTab = await receivedAtRemote
    expect(fromTab.message).toEqual({ deviceId: 'aaaa', activity: 'online' })
    expect(deviceIdOfPeer(fromTab.senderId)).toBe('aaaa')
  } finally {
    await Effect.runPromise(Effect.forEach(fibers, Fiber.interrupt))
    await Promise.all([leader.shutdown(), tab.shutdown(), remote.shutdown()])
  }
}, 10000)
