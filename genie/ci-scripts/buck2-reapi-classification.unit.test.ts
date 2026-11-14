import { describe, expect, it } from 'bun:test'

import type { CacheAdmissionInvocation } from './buck2-cache-evidence.ts'
import { collectReapiClassifications } from './buck2-reapi-classification.ts'

const admission: CacheAdmissionInvocation = {
  invocationId: '2fc13b48-c94a-4a9c-936f-bc24615bc360',
  admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
  admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
  event: 'reader-reapi-unavailable-admission',
  reason: 'capabilities',
  phase: 'admission',
}
const inBuild: CacheAdmissionInvocation = {
  invocationId: 'c568610f-0ddf-40c5-99df-d178142b9dad',
  admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
  admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
  event: 'reader-reapi-unavailable-shadow',
  reason: 'connect',
  phase: 'in_build',
  shadow: {
    cause: {
      capabilitiesUnavailable: false,
      connectRetry: true,
      clientInitialization: false,
      connectUnavailable: true,
      transportMessage: 'transport-error',
    },
    command: { subcommand: 'build', argumentCount: 4 },
    nativeExitCode: 1,
    durationMs: 47000,
    failedActionCount: 1,
    wouldDisableRemoteCache: true,
  },
}
const jsonl = (...rows: unknown[]): string => rows.map((row) => JSON.stringify(row)).join('\n')

// These tests deliberately exercise only the pure projection, not filesystem or runner state.
describe('reader REAPI classification outputs', () => {
  it('emits nothing for undefined, empty, or whitespace-only contents', () => {
    for (const contents of [undefined, '', '\n \t\r\n']) {
      expect(collectReapiClassifications(contents)).toEqual({
        output: '',
        diagnostics: '',
        invalidRows: false,
      })
    }
  })

  it('emits only the admission output for an admission classification', () => {
    expect(collectReapiClassifications(jsonl(admission))).toEqual({
      output: 'admission=capabilities\n',
      diagnostics: '',
      invalidRows: false,
    })
  })

  it('emits only the in-build output for a shadow classification', () => {
    expect(collectReapiClassifications(jsonl(inBuild))).toEqual({
      output: 'in_build=connect\n',
      diagnostics: '',
      invalidRows: false,
    })
  })

  it('emits both outputs in phase order regardless of row order', () => {
    expect(collectReapiClassifications(jsonl(inBuild, admission))).toEqual({
      output: 'admission=capabilities\nin_build=connect\n',
      diagnostics: '',
      invalidRows: false,
    })
  })

  it('skips malformed JSON and invalid decoded rows interspersed with valid rows', () => {
    const contents = [
      '{malformed',
      jsonl({ ...admission, reason: 'private-value\n::error::unsafe' }),
      jsonl(admission),
      jsonl({ ...inBuild, phase: 'admission' }),
      'null',
      jsonl({ ...inBuild, shadow: undefined }),
      jsonl(inBuild),
      jsonl({ ...admission, invocationId: 'invalid' }),
    ].join('\n')
    expect(collectReapiClassifications(contents)).toEqual({
      output: 'admission=capabilities\nin_build=connect\n',
      diagnostics: '',
      invalidRows: true,
    })
  })

  it('keeps the first classified reason independently for each phase', () => {
    expect(
      collectReapiClassifications(
        jsonl(
          { ...inBuild, reason: 'init' },
          admission,
          { ...admission, reason: 'connect' },
          inBuild,
        ),
      ),
    ).toEqual({
      output: 'admission=capabilities\nin_build=init\n',
      diagnostics: '',
      invalidRows: false,
    })
  })

  it('ignores valid unclassified and legacy rows without reserving a phase', () => {
    const { reason: _reason, phase: _phase, ...unclassified } = admission
    expect(
      collectReapiClassifications(
        jsonl(
          { ...unclassified, event: 'reader-reapi-unavailable-rerun' },
          unclassified,
          { ...inBuild, reason: undefined, phase: undefined },
          { ...admission, reason: 'init' },
          inBuild,
        ),
      ),
    ).toEqual({
      output: 'admission=init\nin_build=connect\n',
      diagnostics: '',
      invalidRows: false,
    })
  })

  it('emits no output when every row is invalid or unclassified', () => {
    expect(
      collectReapiClassifications(jsonl({}, { reason: 'connect', phase: 'in_build' })),
    ).toEqual({
      output: '',
      diagnostics: '',
      invalidRows: true,
    })
    expect(
      collectReapiClassifications(jsonl({ ...admission, reason: undefined, phase: undefined })),
    ).toEqual({ output: '', diagnostics: '', invalidRows: false })
  })
})

const failedProbe: CacheAdmissionInvocation = {
  ...admission,
  reapiDecision: 'first-probe-for-ci-job',
  reapiFailure: { class: 'deadline', phase: 'response', elapsedMs: 5000, deadlineMs: 5000 },
  reapiAttempts: [
    {
      attemptIndex: 1,
      elapsedMs: 5000,
      deadlineMs: 5000,
      dnsResolvedMs: 2,
      tcpConnectedMs: 12,
      tlsReadyMs: 20,
      connectTlsDeadlineMs: 5000,
      responseDeadlineMs: 2500,
      totalCeilingMs: 8000,
      failure: { class: 'deadline', phase: 'response', elapsedMs: 5000, deadlineMs: 2500 },
    },
    {
      attemptIndex: 2,
      elapsedMs: 5000,
      deadlineMs: 5000,
      dnsResolvedMs: 1,
      tcpConnectedMs: 10,
      tlsReadyMs: 18,
      firstResponseMs: 25,
      failure: { class: 'deadline', phase: 'response', elapsedMs: 5000, deadlineMs: 5000 },
    },
  ],
}

describe('reader REAPI fallback diagnostics', () => {
  it('prints all attempt milestones and failure categories for the first failed probe', () => {
    expect(collectReapiClassifications(jsonl(failedProbe)).diagnostics).toMatchInlineSnapshot(`
      "Buck2 REAPI admission fallback: {"phase":"admission","reason":"capabilities","reapiDecision":"first-probe-for-ci-job","failure":{"class":"deadline","phase":"response"},"attempts":[{"attemptIndex":1,"elapsedMs":5000,"deadlineMs":5000,"dnsResolvedMs":2,"tcpConnectedMs":12,"tlsReadyMs":20,"connectTlsDeadlineMs":5000,"responseDeadlineMs":2500,"totalCeilingMs":8000,"failure":{"class":"deadline","phase":"response"}},{"attemptIndex":2,"elapsedMs":5000,"deadlineMs":5000,"dnsResolvedMs":1,"tcpConnectedMs":10,"tlsReadyMs":18,"firstResponseMs":25,"failure":{"class":"deadline","phase":"response"}}]}
      "
    `)
  })

  it('deduplicates repeated decisions and skips pinned rows even with copied attempt data', () => {
    const diagnostics = collectReapiClassifications(
      jsonl(
        failedProbe,
        failedProbe,
        { ...failedProbe, reapiDecision: 'pinned-from-first-probe' },
        { ...failedProbe, reapiDecision: 'pinned-from-first-probe', reapiAttempts: undefined },
      ),
    ).diagnostics
    expect(diagnostics).toBe(collectReapiClassifications(jsonl(failedProbe)).diagnostics)
    expect(
      collectReapiClassifications(
        jsonl({ ...failedProbe, reapiDecision: 'pinned-from-first-probe' }),
      ).diagnostics,
    ).toMatchInlineSnapshot(`""`)
  })

  it('never exposes addresses, headers, instance names, or credentials from input rows', () => {
    const sentinel = 'https://sentinel.example.invalid/credential-sentinel'
    const contents = jsonl({
      ...failedProbe,
      address: sentinel,
      instanceName: sentinel,
      headers: { authorization: sentinel },
      reapiFailure: { ...failedProbe.reapiFailure, message: sentinel },
      reapiAttempts: failedProbe.reapiAttempts?.map((attempt) => ({
        ...attempt,
        address: sentinel,
        headers: { authorization: sentinel },
        failure: { ...attempt.failure, message: sentinel },
      })),
    })
    const result = collectReapiClassifications(contents)
    expect(result.invalidRows).toBe(false)
    expect(result.diagnostics).toBe(collectReapiClassifications(jsonl(failedProbe)).diagnostics)
    expect(JSON.stringify(result)).not.toContain(sentinel)
  })

  it('prints nothing for healthy probes, including successful retries with failed attempts', () => {
    expect(
      collectReapiClassifications(
        jsonl({
          invocationId: failedProbe.invocationId,
          admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
          admissionRetrySuccesses: { reapi: 1, archiveOrigin: 0 },
          reapiDecision: 'first-probe-for-ci-job',
          reapiAttempts: failedProbe.reapiAttempts,
        }),
      ).diagnostics,
    ).toMatchInlineSnapshot(`""`)
  })

  it('prints failure-only evidence without requiring a decision source or attempt timings', () => {
    expect(
      collectReapiClassifications(
        jsonl({ ...failedProbe, reapiDecision: undefined, reapiAttempts: undefined }),
      ).diagnostics,
    ).toMatchInlineSnapshot(`
      "Buck2 REAPI admission fallback: {"phase":"admission","reason":"capabilities","failure":{"class":"deadline","phase":"response"}}
      "
    `)
  })

  it('caps diagnostics at eight distinct lines without truncating classification collection', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      ...failedProbe,
      reapiAttempts: [{ attemptIndex: 1, elapsedMs: index, deadlineMs: 5000 }],
    }))
    const result = collectReapiClassifications(jsonl(...rows, inBuild))
    expect(result.diagnostics.trimEnd().split('\n')).toHaveLength(8)
    expect(result.output).toMatchInlineSnapshot(`
      "admission=capabilities
      in_build=connect
      "
    `)
  })
})
