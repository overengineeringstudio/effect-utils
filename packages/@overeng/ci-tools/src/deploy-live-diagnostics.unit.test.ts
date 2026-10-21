import { describe, expect, it } from 'vitest'

import { formatLiveDeployFailure } from './deploy-live-diagnostics.ts'

// Synthetic reports: no provider, network, or credentials are needed.
describe('live deploy failure diagnostics', () => {
  it('publishes only known classifications and numeric HTTP statuses', () => {
    const diagnostic = formatLiveDeployFailure({
      status: 1,
      report: `WORKFLOW_REPORT_V1: ${JSON.stringify({
        summary: 'private provider output',
        data: {
          target: 'private-project',
          errorKind: 'ProviderOperationFailed',
          operation: 'deploy',
          diagnostics: { apiStatus: '403', httpStatus: 503, stderr: 'private child output' },
        },
      })}`,
    })

    expect(JSON.parse(diagnostic)).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      apiStatus: 403,
      httpStatus: 503,
    })
  })

  it.each([
    String.raw`https:\/\/example.invalid\/deploy?secret=escaped-url-sentinel`,
    String.raw`\u0075\u006e\u0069\u0063\u006f\u0064\u0065-sentinel`,
    Buffer.from('base64-secret-sentinel').toString('base64'),
    'split-secret\nsentinel',
    'quoted-"secret"-sentinel',
  ])(
    'omits encoded or split private data without inspecting its representation: %j',
    (privateValue) => {
      const input = {
        status: 1,
        stdout: privateValue,
        stderr: privateValue,
        report: `WORKFLOW_REPORT_V1: ${JSON.stringify({
          summary: privateValue,
          links: [{ url: privateValue }],
          data: {
            errorKind: 'ProviderOperationFailed',
            operation: 'deploy',
            target: privateValue,
            diagnostics: { stdout: privateValue, stderr: privateValue, code: privateValue },
          },
        })}`,
      }
      const diagnostic = formatLiveDeployFailure(input)

      expect(JSON.parse(diagnostic)).toEqual({
        exitStatus: 1,
        errorKind: 'ProviderOperationFailed',
        operation: 'deploy',
      })
      expect(diagnostic).not.toContain(privateValue)
    },
  )

  it.each([
    undefined,
    'not a workflow report',
    'WORKFLOW_REPORT_V1: {invalid JSON',
    'WORKFLOW_REPORT_V1: {"data":null}',
    String.raw`WORKFLOW_REPORT_V1: {"data":{"errorKind":"https:\/\/private.invalid"}}`,
    String.raw`WORKFLOW_REPORT_V1: {"data":{"operation":"\u0073\u0065\u0063\u0072\u0065\u0074"}}`,
    'WORKFLOW_REPORT_V1: {"data":{"errorKind":"c2VjcmV0"}}',
    'WORKFLOW_REPORT_V1: {"data":{"operation":"split-secret\\nsentinel"}}',
  ])('fails closed for absent, malformed or unrecognized report classifications: %j', (report) => {
    expect(JSON.parse(formatLiveDeployFailure({ status: null, report }))).toEqual({
      exitStatus: null,
    })
  })

  it.each(['403-secret', '0403', '999', 99, 600, 403.5])(
    'omits unrecognized numeric status representations: %j',
    (status) => {
      const report = `WORKFLOW_REPORT_V1: ${JSON.stringify({
        data: { diagnostics: { apiStatus: status, httpStatus: status } },
      })}`
      expect(JSON.parse(formatLiveDeployFailure({ status: 1, report }))).toEqual({ exitStatus: 1 })
    },
  )
})
