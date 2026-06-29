/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Phase 2 exports the deploy wire contract as a dense schema surface. */

import { Schema } from 'effect'

import { OtelAttr, OtelOperation } from '@overeng/otel-contract'

import type { WorkflowReportRecord } from './mod.ts'

export const DeployProvider = Schema.Literal('netlify', 'vercel').annotations({
  identifier: 'CiTools.Deploy.Provider',
})
export type DeployProvider = typeof DeployProvider.Type

export const DeployMode = Schema.Literal('prod', 'pr', 'draft', 'preview').annotations({
  identifier: 'CiTools.Deploy.Mode',
})
export type DeployMode = typeof DeployMode.Type

export const DeployStatus = Schema.Literal('success', 'failure', 'skipped').annotations({
  identifier: 'CiTools.Deploy.Status',
})
export type DeployStatus = typeof DeployStatus.Type

export const PositiveInt = Schema.Number.pipe(
  Schema.int(),
  Schema.positive(),
  Schema.annotations({ identifier: 'CiTools.Deploy.PositiveInt' }),
)
export type PositiveInt = typeof PositiveInt.Type

export const DeployTarget = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^[A-Za-z0-9._/-]+$/u),
  Schema.annotations({ identifier: 'CiTools.Deploy.Target' }),
)
export type DeployTarget = typeof DeployTarget.Type

export const DeployAlias = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9-]{0,62}$/u),
  Schema.annotations({ identifier: 'CiTools.Deploy.Alias' }),
)
export type DeployAlias = typeof DeployAlias.Type

export const EnvVarName = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^[A-Z_][A-Z0-9_]*$/u),
  Schema.annotations({ identifier: 'CiTools.Deploy.EnvVarName' }),
)
export type EnvVarName = typeof EnvVarName.Type

export const RelativeHttpPath = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^\//u),
  Schema.annotations({ identifier: 'CiTools.Deploy.RelativeHttpPath' }),
)
export type RelativeHttpPath = typeof RelativeHttpPath.Type

export const HttpsUrl = Schema.URL.pipe(
  Schema.filter((url) => url.protocol === 'https:', {
    message: () => 'URL must use https:',
  }),
  Schema.annotations({ identifier: 'CiTools.Deploy.HttpsUrl' }),
)
export type HttpsUrl = typeof HttpsUrl.Type

export const DeployDiagnostic = Schema.Record({
  key: Schema.NonEmptyTrimmedString,
  value: Schema.NonEmptyTrimmedString,
}).annotations({ identifier: 'CiTools.Deploy.Diagnostic' })
export type DeployDiagnostic = typeof DeployDiagnostic.Type

export const NetlifyProviderConfig = Schema.TaggedStruct('NetlifyProviderConfig', {
  siteIdEnv: EnvVarName,
  authTokenEnv: EnvVarName,
  accountSlugEnv: Schema.optional(EnvVarName),
}).annotations({ identifier: 'CiTools.Deploy.NetlifyProviderConfig' })
export type NetlifyProviderConfig = typeof NetlifyProviderConfig.Type

export const VercelProviderConfig = Schema.TaggedStruct('VercelProviderConfig', {
  projectIdEnv: EnvVarName,
  orgIdEnv: EnvVarName,
  authTokenEnv: EnvVarName,
  teamIdEnv: Schema.optional(EnvVarName),
}).annotations({ identifier: 'CiTools.Deploy.VercelProviderConfig' })
export type VercelProviderConfig = typeof VercelProviderConfig.Type

export const DeployProviderConfig = Schema.Union(
  NetlifyProviderConfig,
  VercelProviderConfig,
).annotations({ identifier: 'CiTools.Deploy.ProviderConfig' })
export type DeployProviderConfig = typeof DeployProviderConfig.Type

export const DeployE2EConfig = Schema.TaggedStruct('DeployE2EConfig', {
  enabled: Schema.Boolean,
  allowSharedProject: Schema.Boolean,
  reservedAliasPrefix: DeployAlias,
  verifyContent: Schema.optional(
    Schema.TaggedStruct('DeployVerifyContent', {
      path: RelativeHttpPath,
      expectedText: Schema.NonEmptyTrimmedString,
    }).annotations({ identifier: 'CiTools.Deploy.VerifyContent' }),
  ),
}).annotations({ identifier: 'CiTools.Deploy.E2EConfig' })
export type DeployE2EConfig = typeof DeployE2EConfig.Type

export const DeployInputV1 = Schema.TaggedStruct('DeployInput', {
  schemaVersion: Schema.Literal(1),
  provider: DeployProvider,
  target: DeployTarget,
  displayName: Schema.optional(Schema.NonEmptyTrimmedString),
  mode: DeployMode,
  artifactDir: Schema.NonEmptyTrimmedString,
  alias: Schema.optional(DeployAlias),
  pr: Schema.optional(PositiveInt),
  gitSha: Schema.optional(Schema.NonEmptyTrimmedString),
  runId: Schema.optional(Schema.NonEmptyTrimmedString),
  workflowReportOutputFile: Schema.optional(Schema.NonEmptyTrimmedString),
  e2e: Schema.optional(DeployE2EConfig),
  providerConfig: DeployProviderConfig,
}).annotations({ identifier: 'CiTools.Deploy.InputV1' })
export type DeployInputV1 = typeof DeployInputV1.Type

export const CleanupResult = Schema.TaggedStruct('CleanupResult', {
  status: Schema.Literal('succeeded', 'failed', 'skipped'),
  message: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'CiTools.Deploy.CleanupResult' })
export type CleanupResult = typeof CleanupResult.Type

export const DeployResultV1 = Schema.TaggedStruct('DeployResult', {
  schemaVersion: Schema.Literal(1),
  provider: DeployProvider,
  target: DeployTarget,
  mode: DeployMode,
  deployId: Schema.optional(Schema.NonEmptyTrimmedString),
  rawDeployUrl: HttpsUrl,
  finalUrl: HttpsUrl,
  alias: Schema.optional(DeployAlias),
  startedAtUtc: Schema.DateTimeUtc,
  endedAtUtc: Schema.DateTimeUtc,
  attempts: PositiveInt,
  cleanup: Schema.optional(CleanupResult),
}).annotations({ identifier: 'CiTools.Deploy.ResultV1' })
export type DeployResultV1 = typeof DeployResultV1.Type

const DeployFailureFields = {
  provider: DeployProvider,
  target: DeployTarget,
  message: Schema.NonEmptyTrimmedString,
  diagnostics: Schema.optional(DeployDiagnostic),
} as const

export class MissingAuth extends Schema.TaggedError<MissingAuth>(
  '@overeng/ci-tools/deploy/MissingAuth',
)('MissingAuth', {
  ...DeployFailureFields,
  envVar: EnvVarName,
}) {
  override get message(): string {
    return `missing ${this.provider} auth env var ${this.envVar} for ${this.target}`
  }
}

export class Unauthorized extends Schema.TaggedError<Unauthorized>(
  '@overeng/ci-tools/deploy/Unauthorized',
)('Unauthorized', {
  ...DeployFailureFields,
}) {
  override get message(): string {
    return `${this.provider} rejected deploy credentials for ${this.target}`
  }
}

export class MissingBuildOutput extends Schema.TaggedError<MissingBuildOutput>(
  '@overeng/ci-tools/deploy/MissingBuildOutput',
)('MissingBuildOutput', {
  ...DeployFailureFields,
  artifactDir: Schema.NonEmptyTrimmedString,
}) {
  override get message(): string {
    return `missing build output for ${this.target}: ${this.artifactDir}`
  }
}

export class ProviderProjectLookupFailed extends Schema.TaggedError<ProviderProjectLookupFailed>(
  '@overeng/ci-tools/deploy/ProviderProjectLookupFailed',
)('ProviderProjectLookupFailed', {
  ...DeployFailureFields,
  transient: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.provider} project lookup failed for ${this.target}`
  }
}

export class InvalidProviderOutput extends Schema.TaggedError<InvalidProviderOutput>(
  '@overeng/ci-tools/deploy/InvalidProviderOutput',
)('InvalidProviderOutput', {
  ...DeployFailureFields,
  outputKind: Schema.Literal('json', 'url', 'workflow-report-record', 'provider-response'),
}) {
  override get message(): string {
    return `${this.provider} returned invalid ${this.outputKind} output for ${this.target}`
  }
}

export class ProviderOperationFailed extends Schema.TaggedError<ProviderOperationFailed>(
  '@overeng/ci-tools/deploy/ProviderOperationFailed',
)('ProviderOperationFailed', {
  ...DeployFailureFields,
  operation: Schema.Literal('resolve-project', 'deploy', 'alias', 'verify', 'cleanup'),
  transient: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.provider} ${this.operation} failed for ${this.target}`
  }
}

export class UnsafeE2EAlias extends Schema.TaggedError<UnsafeE2EAlias>(
  '@overeng/ci-tools/deploy/UnsafeE2EAlias',
)('UnsafeE2EAlias', {
  ...DeployFailureFields,
  alias: DeployAlias,
  reservedAliasPrefix: DeployAlias,
}) {
  override get message(): string {
    return `unsafe live E2E alias ${this.alias} for ${this.target}`
  }
}

export class VerificationFailed extends Schema.TaggedError<VerificationFailed>(
  '@overeng/ci-tools/deploy/VerificationFailed',
)('VerificationFailed', {
  ...DeployFailureFields,
  finalUrl: HttpsUrl,
  transient: Schema.Boolean,
}) {
  override get message(): string {
    return `${this.provider} verification failed for ${this.target}`
  }
}

export const DeployFailure = Schema.Union(
  MissingAuth,
  Unauthorized,
  MissingBuildOutput,
  ProviderProjectLookupFailed,
  InvalidProviderOutput,
  ProviderOperationFailed,
  UnsafeE2EAlias,
  VerificationFailed,
).annotations({ identifier: 'CiTools.Deploy.Failure' })
export type DeployFailure = typeof DeployFailure.Type

export const deployFailureRetryability = (failure: DeployFailure): boolean => {
  switch (failure._tag) {
    case 'ProviderProjectLookupFailed':
    case 'VerificationFailed':
    case 'ProviderOperationFailed':
      return failure.transient
    case 'MissingAuth':
    case 'Unauthorized':
    case 'MissingBuildOutput':
    case 'InvalidProviderOutput':
    case 'UnsafeE2EAlias':
      return false
  }
}

export type DeployRecordContext = {
  readonly input: DeployInputV1
  readonly createdAtUtc: string
}

const DeployWorkflowReportSubject = Schema.Struct({
  id: Schema.NonEmptyTrimmedString,
  label: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'CiTools.Deploy.WorkflowReportSubject' })

const DeployWorkflowReportHttpsUrlString = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^https:\/\/[^\s]+$/u),
  Schema.annotations({ identifier: 'CiTools.Deploy.WorkflowReportHttpsUrlString' }),
)

const DeployWorkflowReportLink = Schema.Struct({
  label: Schema.NonEmptyTrimmedString,
  url: DeployWorkflowReportHttpsUrlString,
  primary: Schema.optional(Schema.Boolean),
}).annotations({ identifier: 'CiTools.Deploy.WorkflowReportLink' })

const DeployWorkflowReportRecordData = Schema.Record({
  key: Schema.NonEmptyTrimmedString,
  value: Schema.Unknown,
}).annotations({ identifier: 'CiTools.Deploy.WorkflowReportRecordData' })

const DeployWorkflowReportRecord = Schema.TaggedStruct('WorkflowReportRecord', {
  schemaVersion: Schema.Literal(1),
  id: Schema.NonEmptyTrimmedString,
  kind: Schema.NonEmptyTrimmedString,
  subject: DeployWorkflowReportSubject,
  status: Schema.Literal('success', 'failure', 'skipped', 'neutral'),
  title: Schema.NonEmptyTrimmedString,
  summary: Schema.optional(Schema.String),
  createdAtUtc: Schema.NonEmptyTrimmedString.pipe(
    Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u),
  ),
  links: Schema.optional(Schema.Array(DeployWorkflowReportLink)),
  data: Schema.optional(DeployWorkflowReportRecordData),
}).annotations({ identifier: 'CiTools.Deploy.WorkflowReportRecord' })

const validateWorkflowReportRecord = (record: WorkflowReportRecord): WorkflowReportRecord =>
  Schema.decodeUnknownSync(DeployWorkflowReportRecord)(record) as WorkflowReportRecord

const deployRecordId = (provider: DeployProvider, target: string) => `deploy-${provider}-${target}`

const deployRecordSubject = (input: DeployInputV1) => ({
  id: input.target,
  label: input.displayName ?? input.target,
})

const deployRecordTitle = (input: DeployInputV1, suffix: string) =>
  `${input.displayName ?? input.target} preview ${suffix}`

const sanitizedDiagnostics = (diagnostics: DeployDiagnostic | undefined) =>
  diagnostics === undefined
    ? undefined
    : Object.fromEntries(
        Object.entries(diagnostics).toSorted(([left], [right]) => left.localeCompare(right)),
      )

export const redactDeployDiagnosticText = (
  text: string,
  opts: { readonly secretValues?: readonly string[] } = {},
) => {
  let redacted = text
  for (const secret of opts.secretValues ?? []) {
    if (secret.trim().length > 0) {
      redacted = redacted.split(secret).join('[REDACTED]')
    }
  }
  return redacted
    .replace(/(authorization:\s*bearer\s+)[^\s]+/giu, '$1[REDACTED]')
    .replace(/((?:token|secret|password|api[_-]?key)=)[^\s&]+/giu, '$1[REDACTED]')
}

export const redactDeployDiagnostics = (
  diagnostics: DeployDiagnostic,
  opts: { readonly secretValues?: readonly string[] } = {},
): DeployDiagnostic =>
  Object.fromEntries(
    Object.entries(diagnostics).map(([key, value]) => [
      key,
      redactDeployDiagnosticText(value, opts),
    ]),
  )

export const deploySuccessRecord = (
  opts: DeployRecordContext & { readonly result: DeployResultV1 },
) =>
  validateWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: deployRecordId(opts.input.provider, opts.input.target),
    kind: 'deploy-preview',
    subject: deployRecordSubject(opts.input),
    status: 'success',
    title: deployRecordTitle(opts.input, 'deployed'),
    summary: 'Preview is ready',
    createdAtUtc: opts.createdAtUtc,
    links: [
      {
        label: 'Preview',
        url: opts.result.finalUrl.toString(),
        primary: true,
      },
    ],
    data: {
      provider: opts.input.provider,
      target: opts.input.target,
      mode: opts.input.mode,
      attempts: opts.result.attempts,
      ...(opts.result.alias === undefined ? {} : { alias: opts.result.alias }),
      ...(opts.result.cleanup === undefined ? {} : { cleanup: opts.result.cleanup.status }),
    },
  })

export const deployFailureRecord = (opts: {
  readonly input: DeployInputV1
  readonly failure: DeployFailure
  readonly attempts: number
  readonly createdAtUtc: string
  readonly secretValues?: readonly string[]
}): WorkflowReportRecord => {
  const diagnostics = sanitizedDiagnostics(
    opts.failure.diagnostics === undefined
      ? undefined
      : redactDeployDiagnostics(
          opts.failure.diagnostics,
          opts.secretValues === undefined ? {} : { secretValues: opts.secretValues },
        ),
  )

  return validateWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: deployRecordId(opts.input.provider, opts.input.target),
    kind: 'deploy-preview',
    subject: deployRecordSubject(opts.input),
    status: 'failure',
    title: deployRecordTitle(opts.input, 'failed'),
    summary: opts.failure.message,
    createdAtUtc: opts.createdAtUtc,
    data: {
      provider: opts.input.provider,
      target: opts.input.target,
      mode: opts.input.mode,
      errorKind: opts.failure._tag,
      retryable: deployFailureRetryability(opts.failure),
      attempts: opts.attempts,
      ...(diagnostics === undefined ? {} : { diagnostics }),
    },
  })
}

export const deploySkippedRecord = (opts: DeployRecordContext & { readonly reason: string }) =>
  validateWorkflowReportRecord({
    _tag: 'WorkflowReportRecord',
    schemaVersion: 1,
    id: deployRecordId(opts.input.provider, opts.input.target),
    kind: 'deploy-preview',
    subject: deployRecordSubject(opts.input),
    status: 'skipped',
    title: deployRecordTitle(opts.input, 'skipped'),
    summary: opts.reason,
    createdAtUtc: opts.createdAtUtc,
    data: {
      provider: opts.input.provider,
      target: opts.input.target,
      mode: opts.input.mode,
    },
  })

export const DeploySpanName = Schema.Literal(
  'ci-tools.deploy',
  'ci-tools.deploy.provider',
  'ci-tools.deploy.attempt',
  'ci-tools.deploy.verify',
  'ci-tools.deploy.cleanup',
).annotations({ identifier: 'CiTools.Deploy.SpanName' })
export type DeploySpanName = typeof DeploySpanName.Type

export const DeploySpanAttributes = Schema.Struct({
  'span.label': Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(40),
    Schema.annotations({ identifier: 'CiTools.Deploy.SpanLabel' }),
  ),
  'ci_tools.deploy.provider': DeployProvider,
  'ci_tools.deploy.target': DeployTarget,
  'ci_tools.deploy.mode': Schema.optional(DeployMode),
  'ci_tools.deploy.operation': Schema.optional(
    Schema.Literal('core', 'provider', 'attempt', 'verify', 'cleanup'),
  ),
  'ci_tools.deploy.attempt': Schema.optional(PositiveInt),
  'ci_tools.deploy.status': Schema.optional(DeployStatus),
  'ci_tools.deploy.error_kind': Schema.optional(Schema.NonEmptyTrimmedString),
  'ci_tools.deploy.cleanup_status': Schema.optional(
    Schema.Literal('succeeded', 'failed', 'skipped'),
  ),
  'ci_tools.deploy.url_host': Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'CiTools.Deploy.SpanAttributes' })
export type DeploySpanAttributes = typeof DeploySpanAttributes.Type

const shortSpanLabel = (value: string) => value.slice(0, 40)

const DeployBaseOtelFields = {
  provider: DeployProvider.pipe(
    OtelAttr.key({ key: 'ci_tools.deploy.provider', cardinality: 'low' }),
  ),
  target: DeployTarget.pipe(
    OtelAttr.key({ key: 'ci_tools.deploy.target', cardinality: 'bounded' }),
  ),
} as const

export const DeployOperation = OtelOperation.define({
  name: 'ci-tools.deploy',
  root: true,
  schema: Schema.Struct({
    ...DeployBaseOtelFields,
    mode: DeployMode.pipe(OtelAttr.key({ key: 'ci_tools.deploy.mode', cardinality: 'low' })),
    runId: Schema.optional(
      Schema.NonEmptyTrimmedString.pipe(
        OtelAttr.key({ key: 'ci_tools.deploy.run_id', cardinality: 'high' }),
      ),
    ),
  }),
  label: ({ target }) => shortSpanLabel(target),
})

export const DeployProviderOperation = OtelOperation.define({
  name: 'ci-tools.deploy.provider',
  schema: Schema.Struct(DeployBaseOtelFields),
  label: ({ provider }) => provider,
})

export const DeployAttemptOperation = OtelOperation.define({
  name: 'ci-tools.deploy.attempt',
  schema: Schema.Struct({
    ...DeployBaseOtelFields,
    mode: DeployMode.pipe(OtelAttr.key({ key: 'ci_tools.deploy.mode', cardinality: 'low' })),
    attempt: PositiveInt.pipe(
      OtelAttr.key({ key: 'ci_tools.deploy.attempt', cardinality: 'bounded' }),
    ),
    status: DeployStatus.pipe(OtelAttr.key({ key: 'ci_tools.deploy.status', cardinality: 'low' })),
    errorKind: Schema.optional(
      Schema.NonEmptyTrimmedString.pipe(
        OtelAttr.key({ key: 'ci_tools.deploy.error_kind', cardinality: 'bounded' }),
      ),
    ),
  }),
  label: ({ attempt }) => String(attempt),
})

export const DeployVerifyOperation = OtelOperation.define({
  name: 'ci-tools.deploy.verify',
  schema: Schema.Struct({
    ...DeployBaseOtelFields,
    status: DeployStatus.pipe(OtelAttr.key({ key: 'ci_tools.deploy.status', cardinality: 'low' })),
    urlHost: Schema.NonEmptyTrimmedString.pipe(
      OtelAttr.key({ key: 'ci_tools.deploy.url_host', cardinality: 'bounded' }),
    ),
    errorKind: Schema.optional(
      Schema.NonEmptyTrimmedString.pipe(
        OtelAttr.key({ key: 'ci_tools.deploy.error_kind', cardinality: 'bounded' }),
      ),
    ),
  }),
  label: ({ urlHost }) => shortSpanLabel(urlHost),
})

export const DeployCleanupOperation = OtelOperation.define({
  name: 'ci-tools.deploy.cleanup',
  schema: Schema.Struct({
    ...DeployBaseOtelFields,
    cleanupId: Schema.optional(
      Schema.NonEmptyTrimmedString.pipe(
        OtelAttr.key({ key: 'ci_tools.deploy.cleanup_id', cardinality: 'high' }),
      ),
    ),
    cleanupStatus: Schema.Literal('succeeded', 'failed', 'skipped').pipe(
      OtelAttr.key({ key: 'ci_tools.deploy.cleanup_status', cardinality: 'low' }),
    ),
  }),
  label: ({ cleanupId, cleanupStatus }) => shortSpanLabel(cleanupId ?? cleanupStatus),
})

export const deploySpanAttributes = (opts: {
  readonly name: DeploySpanName
  readonly input: DeployInputV1
  readonly attempt?: number
  readonly status?: DeployStatus
  readonly failure?: DeployFailure
  readonly finalUrl?: URL
  readonly cleanup?: CleanupResult
}): DeploySpanAttributes => {
  const operation =
    opts.name === 'ci-tools.deploy'
      ? 'core'
      : opts.name === 'ci-tools.deploy.provider'
        ? 'provider'
        : opts.name === 'ci-tools.deploy.attempt'
          ? 'attempt'
          : opts.name === 'ci-tools.deploy.verify'
            ? 'verify'
            : 'cleanup'
  const label =
    operation === 'attempt'
      ? `attempt-${opts.attempt ?? 1}`
      : operation === 'verify' && opts.finalUrl !== undefined
        ? opts.finalUrl.host
        : operation === 'cleanup'
          ? (opts.input.alias ?? opts.input.target)
          : operation === 'provider'
            ? opts.input.provider
            : opts.input.target

  return Schema.decodeUnknownSync(DeploySpanAttributes)({
    'span.label': shortSpanLabel(label),
    'ci_tools.deploy.provider': opts.input.provider,
    'ci_tools.deploy.target': opts.input.target,
    'ci_tools.deploy.mode': opts.input.mode,
    'ci_tools.deploy.operation': operation,
    ...(opts.attempt === undefined ? {} : { 'ci_tools.deploy.attempt': opts.attempt }),
    ...(opts.status === undefined ? {} : { 'ci_tools.deploy.status': opts.status }),
    ...(opts.failure === undefined ? {} : { 'ci_tools.deploy.error_kind': opts.failure._tag }),
    ...(opts.cleanup === undefined
      ? {}
      : { 'ci_tools.deploy.cleanup_status': opts.cleanup.status }),
    ...(opts.finalUrl === undefined ? {} : { 'ci_tools.deploy.url_host': opts.finalUrl.host }),
  })
}
