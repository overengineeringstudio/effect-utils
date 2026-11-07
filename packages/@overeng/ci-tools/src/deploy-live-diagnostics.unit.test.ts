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

  it('extracts only known codes from the pinned CLI Diagnostic error format', () => {
    expect(
      JSON.parse(
        formatLiveDeployFailure({
          status: 1,
          includeProviderCause: true,
          report: report({
            exitCode: '1',
            apiStatus: '429',
            stderr:
              'Vercel CLI 60.1.3\nError: [builds_rate_limited] private provider message\nError: [unknown_private_code] other text',
          }),
        }),
      ),
    ).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      apiStatus: 429,
      providerExitCode: 1,
      providerErrorCodes: ['builds_rate_limited'],
      providerFailureKind: 'rate_limited',
    })
  })

  it.each([
    'private/token with spaces',
    'private%2ftoken+with+spaces',
    'private%2Ftoken%20with%20spaces',
    String.raw`private\/token`,
    String.raw`private-\"quoted\"-token`,
    String.raw`\u0070\u0072\u0069\u0076\u0061\u0074\u0065`,
    Buffer.from('private-token').toString('base64'),
    'private_token_that_matches_code_grammar',
    'split-private\nsentinel',
  ])('never publishes free text with provider diagnostics enabled: %j', (secret) => {
    expect(
      JSON.parse(
        formatLiveDeployFailure({
          status: 1,
          includeProviderCause: true,
          report: report({
            exitCode: '1-private',
            stdout: secret,
            stderr: `${secret}\nError: [${secret}] private\nError: private (${secret})`,
            code: secret,
          }),
        }),
      ),
    ).toEqual({
      exitStatus: 1,
      errorKind: 'ProviderOperationFailed',
      operation: 'deploy',
      providerFailureKind: 'unknown',
    })
  })

  it.each([
    ['Error: [rate_limited] Too many requests', 'rate_limited'],
    ['Error: [builds_rate_limited] Try again tomorrow', 'rate_limited'],
    ['Error: [forbidden] Not authorized', 'auth'],
    ['Error: [not_found] Resource unavailable', 'not_found'],
    ['Error: request timed out', 'timeout'],
    ['Error: Deployment rejected for another reason', 'unknown'],
  ])('prints a redacted provider reason for %s', (stderr, kind) => {
    const formatted = JSON.parse(
      formatLiveDeployFailure({
        status: 1,
        includeProviderCause: true,
        secretValues: ['fixture-token', 'fixture-bypass'],
        report: report({
          exitCode: '1',
          stderr: `${stderr}\ncredential fixture-token bypass fixture-bypass\nAuthorization: Bearer fixture-other\ntoken=fixture-param`,
        }),
      }),
    )
    expect(formatted.providerFailureKind).toBe(kind)
    expect(formatted.providerDiagnostic).toBe(
      `${stderr}\ncredential [REDACTED] bypass [REDACTED]\nAuthorization: Bearer [REDACTED]\ntoken=[REDACTED]`,
    )
  })

  it('redacts before bounding the last 20 lines and 4096 characters', () => {
    const secret = `fixture-${'s'.repeat(4100)}`
    const formatted = JSON.parse(
      formatLiveDeployFailure({
        status: 1,
        includeProviderCause: true,
        secretValues: [secret],
        report: report({
          stderr: `${'discarded\n'.repeat(25)}${'x'.repeat(5000)}\n${secret}\nError: deployment rejected`,
        }),
      }),
    )
    expect(formatted.providerDiagnostic.length).toBe(4096)
    expect(formatted.providerDiagnostic.split('\n').length <= 20).toBe(true)
    expect(formatted.providerDiagnostic.includes('discarded')).toBe(false)
    expect(formatted.providerDiagnostic.endsWith('[REDACTED]\nError: deployment rejected')).toBe(
      true,
    )
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
