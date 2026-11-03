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
      expect(collectReapiClassifications(contents)).toEqual({ output: '', invalidRows: false })
    }
  })

  it('emits only the admission output for an admission classification', () => {
    expect(collectReapiClassifications(jsonl(admission))).toEqual({
      output: 'admission=capabilities\n',
      invalidRows: false,
    })
  })

  it('emits only the in-build output for a shadow classification', () => {
    expect(collectReapiClassifications(jsonl(inBuild))).toEqual({
      output: 'in_build=connect\n',
      invalidRows: false,
    })
  })

  it('emits both outputs in phase order regardless of row order', () => {
    expect(collectReapiClassifications(jsonl(inBuild, admission))).toEqual({
      output: 'admission=capabilities\nin_build=connect\n',
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
    ).toEqual({ output: 'admission=capabilities\nin_build=init\n', invalidRows: false })
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
    ).toEqual({ output: 'admission=init\nin_build=connect\n', invalidRows: false })
  })

  it('emits no output when every row is invalid or unclassified', () => {
    expect(
      collectReapiClassifications(jsonl({}, { reason: 'connect', phase: 'in_build' })),
    ).toEqual({
      output: '',
      invalidRows: true,
    })
    expect(
      collectReapiClassifications(jsonl({ ...admission, reason: undefined, phase: undefined })),
    ).toEqual({ output: '', invalidRows: false })
  })
})
