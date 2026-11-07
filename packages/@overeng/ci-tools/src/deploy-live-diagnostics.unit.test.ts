import { describe, expect, it } from 'vitest'

import { formatLiveDeployFailure, vercelLiveProcessEnvironment } from './deploy-live-diagnostics.ts'

const report = (diagnostics: Record<string, unknown>) =>
  `WORKFLOW_REPORT_V1: ${JSON.stringify({
    summary: 'private provider output',
    data: { errorKind: 'ProviderOperationFailed', operation: 'deploy', diagnostics },
  })}`

// Synthetic reports: no provider, network, or credentials are needed.
describe('live deploy failure diagnostics', () => {
  it('publishes classifications and numeric HTTP statuses by default', () => {
    expect(
      JSON.parse(
        formatLiveDeployFailure({
          status: 1,
          report: report({ apiStatus: '403', httpStatus: 503, stderr: 'private child output' }),
        }),
      ),
    ).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      apiStatus: 403,
      httpStatus: 503,
    })
  })

  it.each([
    [
      'Error: Resource is limited (more than 100, code: "api-deployments-free-per-day")',
      'rate_limited',
      'api-deployments-free-per-day',
    ],
    ['Error: [forbidden] Not authorized', 'auth', 'forbidden'],
    ['Error: [not_found] Resource unavailable', 'not_found', 'not_found'],
    ['Error: [UPPERCASE code] Other failure', 'unknown', 'unrecognized'],
    ['Error: [fixturetokenabcdefghijkl] Other failure', 'unknown', 'unrecognized'],
    ['Error: [prefix-fixturetokenabcdefghijkl-suffix] Other failure', 'unknown', 'unrecognized'],
  ])('publishes only structured diagnostics for %s', (stderr, failureKind, vercelErrorCode) => {
    const formatted = JSON.parse(
      formatLiveDeployFailure({
        status: 1,
        includeProviderCause: true,
        secretValues: ['fixturetokenabcdefghijkl'],
        report: report({
          exitCode: '1',
          stderr: `${stderr}\nteam private-team, owner person@example.invalid, https://private.example.invalid/project\nHTTP 429\nRetry-After: 3600`,
        }),
      }),
    )
    expect(formatted).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      providerExitCode: 1,
      failureKind,
      vercelErrorCode,
      httpStatus: '429',
      retryAfter: '3600',
    })
  })

  it('revalidates structured report fields without publishing provider prose', () => {
    expect(
      JSON.parse(
        formatLiveDeployFailure({
          status: 1,
          includeProviderCause: true,
          secretValues: ['fixture-token'],
          report: report({
            failureKind: 'rate_limited',
            vercelErrorCode: 'api-deployments-free-per-day',
            httpStatus: '429',
            retryAfter: '300',
            stdout: 'private-team person@example.invalid https://private.invalid',
          }),
        }),
      ),
    ).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      failureKind: 'rate_limited',
      vercelErrorCode: 'api-deployments-free-per-day',
      httpStatus: '429',
      retryAfter: '300',
    })
  })

  it.each(['HTTP 999\nRetry-After: 12-private', 'status: 429-secret\nRetry-After: tomorrow'])(
    'omits malformed numeric CLI fields: %s',
    (stderr) => {
      expect(
        JSON.parse(
          formatLiveDeployFailure({
            status: 1,
            includeProviderCause: true,
            report: report({ stderr }),
          }),
        ),
      ).toEqual({
        exitStatus: 1,
        errorKind: 'ProviderOperationFailed',
        operation: 'deploy',
        failureKind: 'unknown',
      })
    },
  )

  it('does not treat a free token as a code', () => {
    expect(
      JSON.parse(
        formatLiveDeployFailure({
          status: 1,
          includeProviderCause: true,
          report: report({
            stderr:
              'fixturetokenabcdefghijkl private-team person@example.invalid https://private.invalid',
          }),
        }),
      ),
    ).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      failureKind: 'unknown',
    })
  })

  it('retains only secret-named inherited Vercel values for leak assertions', () => {
    const environment = vercelLiveProcessEnvironment({
      VERCEL_TOKEN: 'token-sentinel',
      VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass-sentinel',
      VERCEL_OIDC_TOKEN: 'oidc-sentinel',
      VERCEL_CUSTOM_TOKEN: 'custom-token-sentinel',
      VERCEL_CUSTOM_SECRET: 'custom-secret-sentinel',
      VERCEL_SCOPE: 'ci',
      VERCEL_PROJECT_ID: 'project',
      VERCEL_FLAG: '1',
      VERCEL_EMPTY_TOKEN: '',
      VERCEL_UNSET_TOKEN: undefined,
      DEVENV_TASK_OUTPUT_FILE: 'parent-output.json',
    })
    expect(environment.env).toMatchObject({ VERCEL_SCOPE: 'ci' } satisfies NodeJS.ProcessEnv)
    expect(environment.env).not.toHaveProperty('DEVENV_TASK_OUTPUT_FILE')
    expect(environment.secretValues).toEqual([
      'token-sentinel',
      'bypass-sentinel',
      'oidc-sentinel',
      'custom-token-sentinel',
      'custom-secret-sentinel',
    ])
    const successOutput = 'Vercel deploy URL: https://ci-tools-e2e-example.vercel.app'
    expect(environment.secretValues.some((secret) => successOutput.includes(secret))).toBe(false)
  })

  it.each([
    undefined,
    'not a workflow report',
    'WORKFLOW_REPORT_V1: {invalid JSON',
    'WORKFLOW_REPORT_V1: {"data":null}',
    String.raw`WORKFLOW_REPORT_V1: {"data":{"errorKind":"https:\/\/private.invalid"}}`,
    String.raw`WORKFLOW_REPORT_V1: {"data":{"operation":"\u0073\u0065\u0063\u0072\u0065\u0074"}}`,
    'WORKFLOW_REPORT_V1: {"data":{"errorKind":"c2VjcmV0"}}',
    'WORKFLOW_REPORT_V1: {"data":{"operation":"split-secret\\nsentinel"}}',
  ])('fails closed for malformed or unrecognized reports: %j', (report) => {
    expect(JSON.parse(formatLiveDeployFailure({ status: null, report }))).toEqual({
      exitStatus: null,
    })
  })

  it.each(['403-secret', '0403', '999', 99, 600, 403.5])(
    'omits unrecognized numeric status representations: %j',
    (status) => {
      expect(
        JSON.parse(
          formatLiveDeployFailure({
            status: 1,
            report: `WORKFLOW_REPORT_V1: ${JSON.stringify({ data: { diagnostics: { apiStatus: status, httpStatus: status } } })}`,
          }),
        ),
      ).toEqual({ exitStatus: 1 })
    },
  )
})
