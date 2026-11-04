import { describe, expect, it } from 'bun:test'

import {
  decidePublisherHead,
  type PublisherState,
  wasCurrentHeadEjected,
} from './publisher-head.ts'

const healthy = {
  kind: 'pr',
  draft: false,
  queued: false,
  ejected: false,
  mergeable: 'MERGEABLE',
  rollup: 'SUCCESS',
} satisfies PublisherState

const before = '2026-11-04T22:00:00Z'
const head = '2026-11-04T23:00:00Z'
const after = '2026-11-04T23:30:00Z'
describe('publisher head pinning', () => {
  const cases: { name: string; state: PublisherState; refresh: boolean; reason: string }[] = [
    { name: 'no open PR', state: { kind: 'no-pr' }, refresh: true, reason: 'no-pr' },
    {
      name: 'pending checks',
      state: { ...healthy, rollup: 'PENDING' },
      refresh: false,
      reason: 'pending',
    },
    {
      name: 'expected checks',
      state: { ...healthy, rollup: 'EXPECTED' },
      refresh: false,
      reason: 'pending',
    },
    { name: 'green checks', state: healthy, refresh: false, reason: 'green' },
    { name: 'queued', state: { ...healthy, queued: true }, refresh: false, reason: 'queued' },
    {
      name: 'queued despite failed head checks',
      state: { ...healthy, queued: true, rollup: 'FAILURE' },
      refresh: false,
      reason: 'queued',
    },
    {
      name: 'conflict',
      state: { ...healthy, mergeable: 'CONFLICTING' },
      refresh: true,
      reason: 'conflict',
    },
    {
      name: 'failed checks',
      state: { ...healthy, rollup: 'FAILURE' },
      refresh: true,
      reason: 'failed',
    },
    {
      name: 'errored checks',
      state: { ...healthy, rollup: 'ERROR' },
      refresh: true,
      reason: 'failed',
    },
    {
      name: 'current green head ejected after its push',
      state: {
        ...healthy,
        ejected: wasCurrentHeadEjected({ headTimes: [head], removalTimes: [after] }),
      },
      refresh: true,
      reason: 'ejected',
    },
    {
      name: 'removal before current head is not an ejection of this head',
      state: {
        ...healthy,
        ejected: wasCurrentHeadEjected({ headTimes: [head], removalTimes: [before] }),
      },
      refresh: false,
      reason: 'green',
    },
    {
      name: 'requeued after ejection',
      state: { ...healthy, queued: true, ejected: true, rollup: 'FAILURE' },
      refresh: false,
      reason: 'queued',
    },
    {
      name: 'GitHub recomputing mergeability',
      state: { ...healthy, mergeable: 'UNKNOWN', rollup: 'FAILURE' },
      refresh: false,
      reason: 'unknown',
    },
    { name: 'draft', state: { ...healthy, draft: true }, refresh: false, reason: 'draft' },
    {
      name: 'missing rollup',
      state: { ...healthy, rollup: null },
      refresh: false,
      reason: 'unknown',
    },
    { name: 'API error', state: { kind: 'api-error' }, refresh: false, reason: 'api-error' },
    {
      name: 'missing timeline keeps a green head',
      state: { ...healthy, ejected: wasCurrentHeadEjected({ headTimes: [head] }) },
      refresh: false,
      reason: 'green',
    },
    {
      name: 'ejection overrides unknown mergeability',
      state: { ...healthy, ejected: true, mergeable: 'UNKNOWN' },
      refresh: true,
      reason: 'ejected',
    },
  ]
  for (const { name, state, refresh, reason } of cases)
    it(name, () => expect(decidePublisherHead(state)).toEqual({ refresh, reason }))
})

describe('current-head ejection evidence', () => {
  it('uses a later force-push time rather than the original commit date', () =>
    expect(wasCurrentHeadEjected({ headTimes: [before, after], removalTimes: [head] })).toBe(false))
  it('uses the latest removal', () =>
    expect(wasCurrentHeadEjected({ headTimes: [head], removalTimes: [before, after] })).toBe(true))
  it('requires removal strictly after the head', () =>
    expect(wasCurrentHeadEjected({ headTimes: [head], removalTimes: [head] })).toBe(false))
  it('ignores missing head timestamps', () =>
    expect(wasCurrentHeadEjected({ removalTimes: [after] })).toBe(false))
  it('ignores empty timeline', () =>
    expect(wasCurrentHeadEjected({ headTimes: [head], removalTimes: [] })).toBe(false))
  it('ignores malformed timeline timestamps', () =>
    expect(wasCurrentHeadEjected({ headTimes: [head], removalTimes: ['unknown'] })).toBe(false))
})
