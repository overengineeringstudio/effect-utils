import { expect, it } from 'bun:test'

import * as Publisher from './publisher-head.ts'

const head = '2026-11-04T20:00:00Z',
  later = '2026-11-04T21:00:00Z'
const now = Date.parse(head) + Publisher.PUBLISHER_HEAD_GRACE_MINUTES * 60_000
const app = 'github-actions'
const suite = (slug = app, name = 'CI') => ({ app: { slug }, workflowRun: { workflow: { name } } })
const check = (conclusion: string, startedAt = head, name = 'CI') => ({
  __typename: 'CheckRun',
  name,
  status: 'COMPLETED',
  conclusion,
  startedAt,
  checkSuite: suite(),
})
const status = (state: string, createdAt = head) => ({
  __typename: 'StatusContext',
  context: 'status',
  state,
  createdAt,
})
const pr = (nodes: unknown[] = [check('SUCCESS')], overrides: Record<string, unknown> = {}) => [
  {
    draft: false,
    queued: false,
    mergeable: 'MERGEABLE',
    headTimes: [head],
    removalTimes: [],
    checks: { pageInfo: { hasNextPage: false }, nodes },
    ...overrides,
  },
]
const rows: [unknown, string, number?][] = [
  [[], 'no-pr'],
  [undefined, 'api-error'],
  [pr(), 'green'],
  [pr([check('CANCELLED')]), 'pending'],
  [pr([check('CANCELLED')]), 'stale-pending', now + 1],
  [pr([check('FAILURE'), check('SUCCESS', later)]), 'green'],
  [pr([check('SUCCESS'), check('FAILURE', later)]), 'failed'],
  [pr([check('FAILURE'), check('CANCELLED', later)]), 'pending'],
  [pr([check('FAILURE'), check('CANCELLED', later, 'other')]), 'failed'],
  [pr([check('FAILURE'), { ...check('SUCCESS', later), checkSuite: suite('other') }]), 'failed'],
  [
    pr([check('FAILURE'), { ...check('CANCELLED', later), checkSuite: suite(undefined, 'other') }]),
    'failed',
  ],
  [pr([], { mergeable: 'CONFLICTING' }), 'conflict'],
  [pr(undefined, { removalTimes: [later] }), 'ejected'],
  [pr(undefined, { headTimes: [head, later], removalTimes: [head] }), 'green'],
  [pr(undefined, { queued: true, removalTimes: [later] }), 'queued'],
  [pr([check('FAILURE')], { queued: true }), 'queued', now + 1],
  [pr(undefined, { mergeable: 'UNKNOWN' }), 'unknown'],
  [pr(undefined, { mergeable: 'UNKNOWN' }), 'stale-unknown', now + 1],
  [pr([], { mergeable: 'UNKNOWN', headTimes: [] }), 'unknown', now + 1],
  [pr([check('PENDING')]), 'pending', now - 1],
  [pr([check('PENDING')]), 'stale-pending', now + 1],
  [pr([check('CANCELLED')], { headTimes: [], committedDate: head }), 'pending', now + 1],
  [pr(undefined, { draft: true }), 'draft'],
  [pr(undefined, { removalTimes: undefined }), 'green'],
  [pr(undefined, { removalTimes: ['invalid'] }), 'green'],
  [pr(undefined, { checks: null }), 'unknown', now + 1],
  [pr(undefined, { checks: { pageInfo: { hasNextPage: true }, nodes: [] } }), 'api-error'],
  [pr([check('FAILURE'), check('CANCELLED')]), 'pending'],
  [pr([{ ...check('FAILURE'), startedAt: null }]), 'pending'],
  [pr([status('FAILURE')]), 'failed'],
  [pr([status('ERROR')]), 'failed'],
  [pr([status('PENDING')]), 'pending'],
  [pr([status('FAILURE'), status('SUCCESS', later)]), 'green'],
  ...['TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED'].map((value): [unknown, string] => [
    pr([check(value)]),
    'failed',
  ]),
  ...['SKIPPED', 'NEUTRAL'].map((value): [unknown, string] => [pr([check(value)]), 'green']),
  [pr([check('STALE')]), 'pending'],
]
it('decodes API evidence and applies the publisher decision table', () => {
  for (const [fixture, reason, time = now] of rows)
    expect(
      Publisher.decidePublisherHead({ state: Publisher.decodePublisherState(fixture), now: time }),
    ).toEqual({
      reason,
      refresh: /^(no-pr|conflict|ejected|failed|stale-)/.test(reason),
    })
})
