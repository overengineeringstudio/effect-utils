import { Result, Schema } from 'effect'

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

// Vercel 60.1.3's output manager renders Diagnostic names as "Error: [name] ...".
// Only publish these known deploy error codes, not arbitrary grammar-valid text
// (a credential could itself match the code grammar).
const vercelErrorCodes: Record<string, true> = {
  builds_rate_limited: true,
  too_many_files: true,
  forbidden: true,
  missing_files: true,
  cert_missing: true,
  not_found: true,
  missing_project_settings: true,
}
const providerCodes = (stderr: string) => {
  const codes = [...stderr.matchAll(/Error:\s*\[([a-z][a-z0-9_]{1,63})\]/gu)]
    .map((match) => match[1])
    .filter((code): code is string => code !== undefined && Object.hasOwn(vercelErrorCodes, code))
  return codes.length === 0 ? undefined : [...new Set(codes)].toSorted()
}

const providerFailureKind = (stderr: string) => {
  if (/rate.?limit|creating deployments at a very fast pace/iu.test(stderr) === true) {
    return 'rate_limited'
  }
  if (/timed? ?out|timeout|ETIMEDOUT/u.test(stderr) === true) return 'timeout'
  if (/unauthorized|forbidden|invalid token|not authorized/iu.test(stderr) === true) return 'auth'
  return undefined
}

/** Publish only finite classifications, numeric statuses and allowlisted provider error codes. */
export const formatLiveDeployFailure = (opts: {
  readonly status: LiveDeployProcessResult['status']
  readonly report: string | undefined
  readonly includeProviderCause?: boolean | undefined
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
            providerErrorCodes: providerCodes(data?.diagnostics?.stderr ?? ''),
            providerFailureKind: providerFailureKind(data?.diagnostics?.stderr ?? ''),
          }),
    },
    undefined,
    2,
  )
}
