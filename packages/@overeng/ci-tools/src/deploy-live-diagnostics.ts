import { Result, Schema } from 'effect'

import { vercelDiagnosticExcerpt, vercelFailureKind, vercelProviderCodes } from './deploy-vercel.ts'

/** Captured child-process outcome retained until live deployment assertions finish. */
export type LiveDeployProcessResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
}

/** Build the child environment and retain only secret-named Vercel values for leak assertions. */
export const vercelLiveProcessEnvironment = (inherited: NodeJS.ProcessEnv) => {
  const { DEVENV_TASK_OUTPUT_FILE: _taskOutputFile, ...env } = inherited
  const childEnv = { ...env, FORCE_COLOR: '0', OTEL_EXPORTER_OTLP_ENDPOINT: '' }
  return {
    env: childEnv,
    secretValues: Object.entries(childEnv)
      .filter(([name]) => /^VERCEL_(?:TOKEN|.*_TOKEN|.*_SECRET)$/u.test(name))
      .map(([, value]) => value)
      .filter((value): value is string => value !== undefined && value.trim().length > 0),
  }
}

const DiagnosticReport = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      errorKind: Schema.optional(
        Schema.Literals([
          'MissingAuth',
          'Unauthorized',
          'MissingBuildOutput',
          'ProviderProjectLookupFailed',
          'InvalidProviderOutput',
          'ProviderOperationFailed',
          'UnsafeE2EAlias',
          'VerificationFailed',
        ]),
      ),
      operation: Schema.optional(
        Schema.Literals(['resolve-project', 'prepare', 'deploy', 'alias', 'verify', 'cleanup']),
      ),
      diagnostics: Schema.optional(
        Schema.Struct({
          apiStatus: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
          httpStatus: Schema.optional(Schema.Union([Schema.String, Schema.Finite])),
          exitCode: Schema.optional(Schema.String),
          stderr: Schema.optional(Schema.String),
        }),
      ),
    }),
  }),
)

const httpStatus = (value: unknown) => {
  const status =
    typeof value === 'string' && /^[1-5]\d{2}$/u.test(value) === true ? Number(value) : value
  if (typeof status !== 'number' || Number.isInteger(status) === false) return undefined
  return status >= 100 && status <= 599 ? status : undefined
}

/** Publish finite classifications and, with explicit secrets, a redacted bounded stderr tail. */
export const formatLiveDeployFailure = (opts: {
  readonly status: LiveDeployProcessResult['status']
  readonly report: string | undefined
  readonly includeProviderCause?: boolean | undefined
  readonly secretValues?: readonly string[]
}): string => {
  const line = opts.report?.split('\n').find((entry) => entry.startsWith('WORKFLOW_REPORT_V1: '))
  const decoded =
    line === undefined
      ? undefined
      : Schema.decodeResult(DiagnosticReport)(line.slice('WORKFLOW_REPORT_V1: '.length))
  const data =
    decoded !== undefined && Result.isSuccess(decoded) === true ? decoded.success.data : undefined
  const exitCode = data?.diagnostics?.exitCode
  return JSON.stringify(
    {
      exitStatus: opts.status,
      errorKind: data?.errorKind,
      operation: data?.operation,
      apiStatus: httpStatus(data?.diagnostics?.apiStatus),
      httpStatus: httpStatus(data?.diagnostics?.httpStatus),
      ...(opts.includeProviderCause !== true
        ? {}
        : {
            providerExitCode:
              exitCode !== undefined && /^\d{1,3}$/u.test(exitCode) === true
                ? Number(exitCode)
                : undefined,
            providerErrorCodes: vercelProviderCodes({ stderr: data?.diagnostics?.stderr ?? '' }),
            providerFailureKind: vercelFailureKind({ stderr: data?.diagnostics?.stderr ?? '' }),
            ...(opts.secretValues === undefined
              ? {}
              : {
                  providerDiagnostic: vercelDiagnosticExcerpt({
                    text: data?.diagnostics?.stderr ?? '',
                    secretValues: opts.secretValues,
                  }),
                }),
          }),
    },
    undefined,
    2,
  )
}
