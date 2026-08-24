import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  BuckEvidenceServiceBinding,
  BuckInvocationCountBridge,
  BuckInvocationDurationMsBridge,
  mintBuckEvidenceServiceIdentity,
} from './telemetry.ts'

describe('service identity (minted via @overeng/otel-contract)', () => {
  it('composes and validates the <project>-<role> name', async () => {
    const identity = await Effect.runPromise(mintBuckEvidenceServiceIdentity())
    expect(identity.name).toBe('effect-utils-buck2')
    expect(identity.namespace).toBe('overeng-build')
    expect(identity.version).toBe(BuckEvidenceServiceBinding.version)
  })

  it('rejects malformed parts at the composition root', async () => {
    // An empty role would compose to "effect-utils-" — the shared naming law
    // must reject it rather than let a trailing-hyphen service.name through.
    const { ServiceNameFromParts } = await import('@overeng/otel-contract')
    const { Schema } = await import('effect')
    const decoded = Schema.decodeUnknownEither(ServiceNameFromParts)({
      project: 'effect-utils',
      role: '',
    })
    expect(decoded._tag).toBe('Left')
  })
})

describe('bounded metric contracts (R06)', () => {
  it('accept the full bounded vocabulary', () =>
    Effect.runPromise(
      Effect.all([
        BuckInvocationCountBridge.increment({
          'cache-class': 'partial',
          'operation-kind': 'build',
          'platform-class': 'linux-x64',
          'result-class': 'success',
        }),
        BuckInvocationDurationMsBridge.record({
          labels: {
            'cache-class': 'hit',
            'operation-kind': 'test',
            'platform-class': 'macos-arm64',
            'result-class': 'failure',
          },
          value: 42,
        }),
      ]).pipe(Effect.asVoid),
    ))
})
