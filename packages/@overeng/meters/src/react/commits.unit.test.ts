import { describe, expect, it } from '@effect/vitest'

import { counterToken, makeInstrumentation } from '../instrumentation/index.ts'
import { makeSeries } from '../series/index.ts'
import { testPlatform } from '../session/_test-platform.ts'
import { makeMeters } from '../session/index.ts'
import { associateProfiler, reactCommitsSource, type ReactCommit } from './commits.ts'

describe('Profiler association contract', () => {
  it('rejects inconsistent IDs in both directions, while repeat registration preserves one feed', () => {
    const first = counterToken({ id: 'first' })
    const second = counterToken({ id: 'second' })
    const instrumentation = makeInstrumentation({ counters: [first, second], gauges: [] })
    const feed = associateProfiler({ instrumentation, counter: first, id: 'host' })
    expect(associateProfiler({ instrumentation, counter: first, id: 'host' })).toBe(feed)
    expect(() => associateProfiler({ instrumentation, counter: first, id: 'another' })).toThrow(
      'Inconsistent Profiler association',
    )
    expect(() => associateProfiler({ instrumentation, counter: second, id: 'host' })).toThrow(
      'Inconsistent Profiler association',
    )
    expect(instrumentation.counter({ token: first }).read()).toBe(0)
    expect(feed.configured).toBe(0)
  })
  it('does not configure callback capability or start collection by defining an event source', () => {
    const host = testPlatform()
    const counter = counterToken({ id: 'commits' })
    const instrumentation = makeInstrumentation({ counters: [counter], gauges: [] })
    const series = makeSeries<ReactCommit>({
      id: 'commits',
      label: 'Commits',
      unit: 'count',
      capacity: 10,
    })
    const source = reactCommitsSource({ id: 'react', series, instrumentation, counter })
    const meters = makeMeters({ sources: [source], platform: host.platform })
    expect(meters.store.read({ series }).latest).toBeUndefined()
    expect(host.requests).toBe(0)
    expect(host.observers).toBe(0)
    expect(instrumentation.counter({ token: counter }).read()).toBe(0)
  })
})
