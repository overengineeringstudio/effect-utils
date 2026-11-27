import type { ChangeFn, Doc, DocHandle } from '@automerge/automerge-repo'
import { Effect, Queue, Stream, SubscriptionRef, type Scope } from 'effect'

/**
 * Effect views of an automerge-repo `DocHandle`.
 *
 * All functions expect a *ready* handle (as returned by `AutomergeRepo.find` / `create`).
 */

/**
 * The document now and after every local or remote change, until the stream is interrupted.
 * Changes that arrive faster than the consumer pulls are coalesced (the consumer always sees
 * the latest document), which is what renderers and reducers over the whole doc want.
 */
export const changes = <T>(handle: DocHandle<T>): Stream.Stream<Doc<T>> =>
  Stream.callback<void>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onChange = () => void Queue.offerUnsafe(queue, undefined)
          handle.on('change', onChange)
          onChange()
          return onChange
        }),
        (onChange) => Effect.sync(() => handle.off('change', onChange)),
      ),
    { bufferSize: 1, strategy: 'sliding' },
  ).pipe(Stream.map(() => handle.doc()))

/**
 * A `SubscriptionRef` mirroring the document for the lifetime of the scope. Writes to the ref
 * do not write to the document — use `change` for that; the ref follows the handle.
 */
export const subscriptionRef = <T>(
  handle: DocHandle<T>,
): Effect.Effect<SubscriptionRef.SubscriptionRef<Doc<T>>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make(handle.doc())
    yield* changes(handle).pipe(
      Stream.runForEach((doc) => SubscriptionRef.set(ref, doc)),
      Effect.forkScoped,
    )
    return ref
  })

/** The current document (synchronously, as of now). */
export const current = <T>(handle: DocHandle<T>): Effect.Effect<Doc<T>> =>
  Effect.sync(() => handle.doc())

/** Applies an immediately observable local change; use AutomergeRepo.save for durable acknowledgement. */
export const change = <T>({
  handle,
  fn,
}: {
  readonly handle: DocHandle<T>
  readonly fn: ChangeFn<T>
}): Effect.Effect<void> => Effect.sync(() => handle.change(fn))

/** An ephemeral (never persisted) message from another peer of a document. */
export interface EphemeralMessage {
  readonly senderId: string
  readonly message: unknown
}

/** A document's ephemeral channel: messages to every peer syncing it, and theirs to us. */
export interface EphemeralChannel {
  readonly send: (message: unknown) => Effect.Effect<void>
  readonly incoming: Stream.Stream<EphemeralMessage>
}

/**
 * The handle's ephemeral channel. Messages reach peers that currently sync the document and are
 * never written to it: presence, invitations, anything that must not become history.
 * Receivers must validate `message` and bind it to `senderId`.
 */
export const ephemeral = <T>(handle: DocHandle<T>): EphemeralChannel => ({
  send: (message) => Effect.sync(() => handle.broadcast(message)),
  incoming: Stream.callback<EphemeralMessage>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const receive = (event: EphemeralMessage) => {
          Queue.offerUnsafe(queue, event)
        }
        handle.on('ephemeral-message', receive)
        return receive
      }),
      (receive) => Effect.sync(() => handle.off('ephemeral-message', receive)),
    ),
  ),
})
