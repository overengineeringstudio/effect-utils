import { expect, it } from 'bun:test'

import { decodeCacheAdmissionInvocation } from '../genie/ci-scripts/buck2-cache-evidence.ts'
import { decodeReapiAdmissionAttempts } from './buck2-cache-posture.ts'

it('preserves successful and TLS-timeout attempt milestones in admission evidence', () => {
  const reapiAttempts = [
    {
      attemptIndex: 1,
      dnsResolvedMs: 3,
      tcpConnectedMs: 10,
      tlsReadyMs: 30,
      firstResponseMs: 40,
      elapsedMs: 42,
      deadlineMs: 2500,
    },
    {
      attemptIndex: 2,
      dnsResolvedMs: 2,
      tcpConnectedMs: 9,
      elapsedMs: 2503,
      deadlineMs: 2500,
      failure: { class: 'deadline', phase: 'tls', elapsedMs: 2503, deadlineMs: 2500 },
    },
  ]
  expect(decodeReapiAdmissionAttempts(reapiAttempts)).toEqual(reapiAttempts)
  const row = {
    invocationId: 'bd999eb2-5b8b-4828-a19a-95bddfb2b27e',
    admissionFallbacks: { reapi: 1, archiveOrigin: 0 },
    admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
    reapiAttempts,
  }
  expect(decodeCacheAdmissionInvocation(row).reapiAttempts).toEqual(reapiAttempts)
  expect(
    decodeCacheAdmissionInvocation({ ...row, reapiAttempts: undefined }).reapiAttempts,
  ).toBeUndefined()
  expect(
    decodeReapiAdmissionAttempts([{ ...reapiAttempts[0], headers: 'secret', path: '/private' }]),
  ).toEqual([reapiAttempts[0]])
  for (const invalid of [
    [{ ...reapiAttempts[0], attemptIndex: 0 }],
    [{ ...reapiAttempts[0], tlsReadyMs: -1 }],
    [{ ...reapiAttempts[1], failure: { class: 'secret' } }],
    null,
  ])
    expect(() => decodeReapiAdmissionAttempts(invalid)).toThrow()
})
