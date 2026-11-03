import { Result, Schema } from 'effect'

import { redactDeployDiagnosticText } from './deploy-domain.ts'

/** Captured child-process outcome retained until live deployment assertions finish. */
export type LiveDeployProcessResult = {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
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

/** Keep reports private by default; callers may opt into a bounded, redacted provider cause. */
export const formatLiveDeployFailure = (opts: {
  readonly status: LiveDeployProcessResult['status']
  readonly report: string | undefined
  readonly providerCause?: { readonly secretValues: readonly string[] } | undefined
}): string => {
  const line = opts.report?.split('\n').find((entry) => entry.startsWith('WORKFLOW_REPORT_V1: '))
  const decoded =
    line === undefined
      ? undefined
      : Schema.decodeResult(DiagnosticReport)(line.slice('WORKFLOW_REPORT_V1: '.length))
  const data =
    decoded !== undefined && Result.isSuccess(decoded) === true ? decoded.success.data : undefined
  // Redact the entire decoded string before truncating: a tail boundary must not
  // expose the suffix of a credential that straddles that boundary.
  const stderrTail =
    opts.providerCause === undefined || data?.diagnostics?.stderr === undefined
      ? undefined
      : redactDeployDiagnosticText(data.diagnostics.stderr, opts.providerCause).trim().slice(-4096)
  const exitCode = data?.diagnostics?.exitCode
  return JSON.stringify(
    {
      exitStatus: opts.status,
      errorKind: data?.errorKind,
      operation: data?.operation,
      apiStatus: httpStatus(data?.diagnostics?.apiStatus),
      httpStatus: httpStatus(data?.diagnostics?.httpStatus),
      ...(opts.providerCause === undefined
        ? {}
        : {
            providerExitCode:
              exitCode !== undefined && /^\d{1,3}$/u.test(exitCode) === true
                ? Number(exitCode)
                : undefined,
            stderrTail: stderrTail === '' ? undefined : stderrTail,
          }),
    },
    undefined,
    2,
  )
}
