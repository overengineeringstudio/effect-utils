import { Data, Deferred, Effect, Stream, SubscriptionRef } from 'effect'

import type { Connection } from './Connection.ts'

/** A connection handler failed; the registry closes its connection and permits a fresh link. */
export class LinkError extends Data.TaggedError('LinkError')<{ readonly cause: unknown }> {}

/**
 * At most one live connection per remote endpoint.
 *
 * When both sides dial each other at once, both keep the connection dialed by the lower
 * endpoint id, so they agree without coordination. A newer connection that wins replaces the
 * old one: the old handler is interrupted (and has finished) before the new one starts.
 */
export interface Links {
  /**
   * Runs `handler` on `conn` until the connection ends or loses to another connection to the
   * same endpoint. Never fails; interruption closes the connection.
   */
  readonly run: (options: {
    readonly conn: Connection
    readonly outgoing: boolean
  }) => Effect.Effect<void>
  /** Endpoints with a live link. */
  readonly connected: SubscriptionRef.SubscriptionRef<ReadonlySet<string>>
  readonly has: (endpointId: string) => boolean
  /** Completes once there is no link to `endpointId` (immediately if there is none). */
  readonly awaitGone: (endpointId: string) => Effect.Effect<void>
}

interface Link {
  readonly outgoing: boolean
  readonly superseded: Deferred.Deferred<void>
  readonly done: Deferred.Deferred<void>
}

/** Creates a connection registry that serializes replacement and resolves simultaneous dialing. */
export const make = ({
  selfId,
  handler,
}: {
  readonly selfId: string
  readonly handler: (conn: Connection) => Effect.Effect<void, LinkError>
}): Effect.Effect<Links> =>
  Effect.gen(function* () {
    const links = new Map<string, Link>()
    const connected = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())
    const publish = Effect.suspend(() => SubscriptionRef.set(connected, new Set(links.keys())))

    /** Which of two connections to the same endpoint both sides keep. */
    const keepsExisting = ({
      existing,
      outgoing,
      remote,
    }: {
      existing: Link
      outgoing: boolean
      remote: string
    }) => {
      const iAmLower = selfId < remote
      // Keep the connection dialed by the lower id: mine if I'm lower, theirs otherwise.
      return existing.outgoing === iAmLower && outgoing !== iAmLower
    }

    const run = ({
      conn,
      outgoing,
    }: {
      conn: Connection
      outgoing: boolean
    }): Effect.Effect<void> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const remote = conn.remoteId
          const existing = links.get(remote)
          if (
            existing !== undefined &&
            keepsExisting({ existing: existing, outgoing: outgoing, remote: remote }) === true
          )
            return yield* conn.close
          const link: Link = {
            outgoing,
            superseded: yield* Deferred.make<void>(),
            done: yield* Deferred.make<void>(),
          }
          links.set(remote, link)
          yield* Effect.gen(function* () {
            if (existing !== undefined) {
              yield* Deferred.succeed(existing.superseded, undefined)
              // Handover must finish even if this replacement is interrupted. Otherwise the next
              // replacement could start while the original handler is still releasing resources.
              yield* Deferred.await(existing.done)
            }
            yield* publish
            yield* restore(
              Effect.raceFirst(
                handler(conn).pipe(
                  Effect.catchCause((cause) => Effect.logDebug(`[links] ${remote} ended`, cause)),
                ),
                Deferred.await(link.superseded),
              ),
            )
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* conn.close
                if (links.get(remote) === link) {
                  links.delete(remote)
                  yield* publish
                }
                yield* Deferred.succeed(link.done, undefined)
              }),
            ),
          )
        }),
      )

    return {
      run,
      connected,
      has: (endpointId) => links.has(endpointId),
      awaitGone: (endpointId) =>
        SubscriptionRef.changes(connected).pipe(
          Stream.filter((set) => set.has(endpointId) === false && links.has(endpointId) === false),
          Stream.runHead,
          Effect.asVoid,
        ),
    }
  })
