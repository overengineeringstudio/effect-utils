import { describe, expect, it } from 'vitest'

import { formatLiveDeployFailure } from './deploy-live-diagnostics.ts'

// Synthetic child output: no provider, network, or credentials are needed.
describe('live deploy failure diagnostics', () => {
  it('retains the child failure and workflow report instead of only the exit status', () => {
    const diagnostic = formatLiveDeployFailure({
      status: 1,
      stdout: 'Preparing static output',
      stderr: 'ProviderOperationFailed: deployment rejected',
      report:
        'WORKFLOW_REPORT_V1: {"status":"failure","data":{"errorKind":"ProviderOperationFailed"}}',
      secretValues: [],
    })

    expect(diagnostic).toContain('ci-tools exit status: 1')
    expect(diagnostic).toContain('stdout:\nPreparing static output')
    expect(diagnostic).toContain('stderr:\nProviderOperationFailed: deployment rejected')
    expect(diagnostic).toContain('workflow report:\nWORKFLOW_REPORT_V1:')
    expect(diagnostic).toContain('"errorKind":"ProviderOperationFailed"')
  })

  it('redacts credentials, account identifiers, and secret-bearing URLs in every channel', () => {
    const diagnostic = formatLiveDeployFailure({
      status: 1,
      stdout: 'token-sentinel project-sentinel https://user:password@example.invalid/deploy',
      stderr:
        'Authorization: Bearer unlisted-token\nhttps://example.invalid/?x-vercel-protection-bypass=encoded%2Fsecret',
      report:
        'WORKFLOW_REPORT_V1: {"message":"bypass-sentinel","url":"https://example.invalid/#private-fragment"}',
      secretValues: ['token-sentinel', 'project-sentinel', 'bypass-sentinel', ''],
    })

    for (const privateValue of [
      'token-sentinel',
      'project-sentinel',
      'bypass-sentinel',
      'unlisted-token',
      'user:password',
      'encoded%2Fsecret',
      'private-fragment',
      'https://',
    ]) {
      expect(diagnostic).not.toContain(privateValue)
    }
    expect(diagnostic).toContain('[REDACTED URL]')
    expect(diagnostic).toContain('Authorization: Bearer [REDACTED]')
  })

  it('explains a missing report without hiding a child terminated by a signal', () => {
    const diagnostic = formatLiveDeployFailure({
      status: null,
      stdout: '',
      stderr: 'child terminated',
      report: undefined,
      secretValues: [],
    })

    expect(diagnostic).toContain('ci-tools exit status: null')
    expect(diagnostic).toContain('child terminated')
    expect(diagnostic).toContain('workflow report:\n(not written)')
  })
})
