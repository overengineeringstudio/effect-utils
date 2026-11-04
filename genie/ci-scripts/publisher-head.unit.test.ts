import { describe, expect, it } from 'bun:test'

import { decidePublisherHead, type PublisherState } from './publisher-head.ts'

const healthy = {
  kind: 'pr',
  draft: false,
  queued: false,
  mergeable: 'MERGEABLE',
  rollup: 'SUCCESS',
} satisfies PublisherState

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
      name: 'ejected with failed checks',
      state: { ...healthy, queued: false, rollup: 'FAILURE' },
      refresh: true,
      reason: 'failed',
    },
    {
      name: 'ejected but green for requeue',
      state: { ...healthy, queued: false },
      refresh: false,
      reason: 'green',
    },
    {
      name: 'requeued after ejection',
      state: { ...healthy, queued: true, rollup: 'FAILURE' },
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
  ]
  for (const { name, state, refresh, reason } of cases)
    it(name, () => expect(decidePublisherHead(state)).toEqual({ refresh, reason }))
})
