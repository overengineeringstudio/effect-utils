import { Effect } from 'effect'

import {
  instrumentationEvidence,
  type CounterToken,
  type Instrumentation,
} from '../instrumentation/index.ts'
import type { Series } from '../series/index.ts'
import { makeSource, type Source } from '../session/source.ts'

/** Evidence emitted only by an actual React Profiler callback. */
export interface ReactCommit {
  readonly _tag: 'ReactCommit'
  readonly id: string
  readonly phase: 'mount' | 'update' | 'nested-update'
  readonly actualDurationMs: number
  readonly baseDurationMs: number
  readonly commitTimeMs: number
  readonly commits: number
}
interface CommitFeed {
  id: string | undefined
  configured: number
  latest: ReactCommit | undefined
  readonly listeners: Set<(commit: ReactCommit | undefined) => void>
}
const feeds = new WeakMap<Instrumentation, Map<CounterToken, CommitFeed>>()
const profilerIds = new WeakMap<Instrumentation, Map<string, CounterToken>>()
/** Internal registry-local callback feed; no globals, observers, or clock ownership. */
export const commitFeed = (options: {
  readonly instrumentation: Instrumentation
  readonly counter: CounterToken
}): CommitFeed => {
  options.instrumentation.counter({ token: options.counter })
  let tokens = feeds.get(options.instrumentation)
  if (tokens === undefined) {
    tokens = new Map()
    feeds.set(options.instrumentation, tokens)
  }
  let feed = tokens.get(options.counter)
  if (feed === undefined) {
    feed = { id: undefined, configured: 0, latest: undefined, listeners: new Set() }
    tokens.set(options.counter, feed)
  }
  return feed
}
/** Register the explicit one-to-one profiler ID/token association in this registry. */
export const associateProfiler = (options: {
  readonly instrumentation: Instrumentation
  readonly counter: CounterToken
  readonly id: string
}): CommitFeed => {
  const feed = commitFeed(options)
  let ids = profilerIds.get(options.instrumentation)
  if (ids === undefined) {
    ids = new Map()
    profilerIds.set(options.instrumentation, ids)
  }
  const token = ids.get(options.id)
  if (
    (feed.id !== undefined && feed.id !== options.id) ||
    (token !== undefined && token !== options.counter)
  ) {
    throw new TypeError(`Inconsistent Profiler association: ${options.id} / ${options.counter.id}`)
  }
  ids.set(options.id, options.counter)
  feed.id = options.id
  return feed
}
/** Subscribe to the injected Profiler feed without mounting React instrumentation. */
export const reactCommitsSource = (options: {
  readonly id: string
  readonly series: Series<ReactCommit>
  readonly instrumentation: Instrumentation
  readonly counter: CounterToken
}): Source<ReactCommit> => {
  const feed = commitFeed(options)
  return makeSource({
    id: options.id,
    series: options.series,
    cadence: { _tag: 'Event' },
    evidence: instrumentationEvidence({ instrumentation: options.instrumentation }),
    start: ({ sink, clock }) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const publish = (commit: ReactCommit | undefined): void => {
            sink.append({
              sample:
                commit === undefined
                  ? { _tag: 'Unavailable', atMs: clock.now(), reason: 'NotConfigured' }
                  : { _tag: 'Value', atMs: clock.now(), value: commit },
            })
          }
          // An installed but callback-incapable build is not a measured zero.
          publish(feed.configured === 0 ? undefined : feed.latest)
          feed.listeners.add(publish)
          return () => {
            feed.listeners.delete(publish)
          }
        }),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
  })
}
