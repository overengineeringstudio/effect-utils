import { Effect, Stream } from 'effect'

import type { PeerAddress } from '@overeng/effect-iroh-browser'

import { runKeyed } from './keyed.ts'
import { Net } from './Net.ts'

/**
 * Keeps a connection to every peer of the latest emitted set, for as long as it runs.
 *
 * `undefined` means "not networked (yet)": nothing starts. The first set — even an empty one —
 * brings the node online with `Net.keepOnline`, and it stays reachable until the effect ends,
 * so peers that show up later can dial in. Peers are keyed by endpoint id and relay; one that
 * disappears from the set releases its dial loop (`Net.connect`'s connection is shared with
 * every other holder of the same peer, including independent consumers on the same device).
 */
export const mesh = <E, R>(
  peers: Stream.Stream<ReadonlyArray<PeerAddress> | undefined, E, R>,
): Effect.Effect<void, E, R | Net> =>
  Effect.scoped(
    Effect.gen(function* () {
      const net = yield* Net
      const scope = yield* Effect.scope
      let started = false
      const desired = peers.pipe(
        Stream.mapEffect((set) =>
          Effect.gen(function* () {
            if (set === undefined) return new Map<string, PeerAddress>()
            if (!started) {
              started = true
              // Stays reachable even if no relay answered at first; other failures are
              // reported in `Net.status`.
              yield* net.keepOnline.pipe(Effect.ignore, Effect.forkIn(scope))
            }
            return new Map(set.map((p) => [`${p.endpointId}@${p.relay}`, p] as const))
          }),
        ),
      )
      yield* runKeyed({
        desired,
        run: (_, peer) =>
          Effect.scoped(net.connect(peer).pipe(Effect.andThen(Effect.never))),
      })
    }),
  )
