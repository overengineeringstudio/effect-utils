import { describe, expect, test } from 'vitest'

import { pipelineJobIdentityForName } from './pipeline-job-names.ts'
import {
  canonicalJobKey,
  deriveJobRootSpanId,
  deriveJobTraceId,
  derivePipelineRootSpanId,
  derivePipelineTraceId,
} from './pipeline-trace-identity.ts'

const run = 'ci/github/overengineeringstudio%2Feffect-utils/421/2'

describe('VRS 01 canonical identity', () => {
  test('frames a runner matrix key and derives stable job/attempt roots', () => {
    const matrix = { runner: 'namespace-profile-linux-x86-64' }
    const key = canonicalJobKey({ job: 'test', dimensions: matrix })
    expect(key.toString('hex')).toBe(
      '0000000474657374000000010000000672756e6e65720000001e6e616d6573706163652d70726f66696c652d6c696e75782d7838362d3634',
    )
    expect(deriveJobTraceId({ runId: run, job: 'test', dimensions: matrix })).toBe(
      'dc8939be377d7ae198ab958b5457787c',
    )
    expect(deriveJobRootSpanId({ runId: run, job: 'test', dimensions: matrix })).toBe(
      '53fa95f498248e99',
    )
    expect(derivePipelineTraceId(run)).toBe('efd25a979cf2466a4af2752063140ffb')
    expect(derivePipelineRootSpanId(run)).toBe('743057364ccd51b2')
    expect(pipelineJobIdentityForName('test (namespace-profile-linux-x86-64)')).toEqual({
      job: 'test',
      dimensions: matrix,
    })
  })

  test('sorts dimension names by UTF-8 bytes and separates ambiguous values', () => {
    expect(canonicalJobKey({ job: 'a', dimensions: { z: '2', a: '1' } })).toEqual(
      canonicalJobKey({ job: 'a', dimensions: { a: '1', z: '2' } }),
    )
    expect(deriveJobTraceId({ runId: run, job: 'a', dimensions: { b: 'c' } })).not.toBe(
      deriveJobTraceId({ runId: run, job: 'a[b=c]', dimensions: {} }),
    )
    expect(deriveJobTraceId({ runId: run, job: 'a', dimensions: { a: 'bc' } })).not.toBe(
      deriveJobTraceId({ runId: run, job: 'a', dimensions: { ab: 'c' } }),
    )
    expect(deriveJobTraceId({ runId: run, job: 'typecheck', dimensions: {} })).not.toBe(
      deriveJobTraceId({ runId: run.replace('/2', '/3'), job: 'typecheck', dimensions: {} }),
    )
    expect(pipelineJobIdentityForName('unknown dynamically named job')).toBeUndefined()
    expect(() => canonicalJobKey({ job: 'test', dimensions: { runner: '' } })).toThrow()
  })
})
