import { expect, test } from 'vitest'

import { closePayload } from './pipeline-attempt-close.ts'
import { deriveJobTraceId } from './pipeline-trace-identity.ts'

const run = 'ci/github/overengineeringstudio%2Feffect-utils/421/2'
const timestamps = { created_at: '2026-09-29T10:00:00Z', updated_at: '2026-09-29T10:12:00Z' }
const job = (name: string, attempt: number, started: string | null) => ({
  name,
  run_attempt: attempt,
  started_at: started,
  completed_at: started,
})

test('attempt close links latest jobs from each job’s own attempt without claiming persistence', () => {
  const { traceId, payload } = closePayload({
    runId: run,
    attempt: 2,
    jobs: [
      job('test (namespace-profile-linux-x86-64)', 2, '2026-09-29T10:01:00Z'),
      job('typecheck', 2, '2026-09-29T10:02:00Z'),
      job('cargo', 2, null),
      job('lint', 1, '2026-09-29T09:00:00Z'),
      job('pr-a-inert-buck', 2, '2026-09-29T10:01:00Z'),
      job('pr-a-inert-buck', 2, null),
      job('unknown dynamically named job', 2, '2026-09-29T10:03:00Z'),
      job('pipeline-attempt-close', 2, '2026-09-29T10:12:00Z'),
    ],
    run: timestamps,
  })
  const root = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
  expect(root.traceId).toBe(traceId)
  expect(root.startTimeUnixNano).toBe('1790676060000000000') // this attempt's first job, not the prior run's creation
  expect(root.endTimeUnixNano).toBe('1790676720000000000')
  expect(root.links).toHaveLength(4) // three started jobs and previous attempt root
  expect(root.links[0]!.traceId).toBe(
    deriveJobTraceId({
      runId: run,
      job: 'test',
      dimensions: { runner: 'namespace-profile-linux-x86-64' },
    }),
  )
  expect(root.links[1]!.traceId).toBe(
    deriveJobTraceId({ runId: run, job: 'typecheck', dimensions: {} }),
  )
  expect(root.links[2]!.traceId).toBe(
    deriveJobTraceId({
      runId: 'ci/github/overengineeringstudio%2Feffect-utils/421/1',
      job: 'lint',
      dimensions: {},
    }),
  )
  expect(
    root.links
      .slice(0, 3)
      .every((link) => link.attributes?.[0]?.value.stringValue === 'unverified'),
  ).toBe(true)
})
