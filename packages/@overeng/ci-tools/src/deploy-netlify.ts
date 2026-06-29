/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Phase 3 exposes the Netlify deploy boundary used by generated tasks. */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'

import { Effect, Either, Schema } from 'effect'

import {
  DeployInputV1,
  type DeployFailure,
  DeployProviderOperation,
  DeployResultV1,
  InvalidProviderOutput,
  MissingAuth,
  ProviderOperationFailed,
  ProviderProjectLookupFailed,
  Unauthorized,
  UnsafeE2EAlias,
  deployFailureRecord,
  deploySkippedRecord,
  deploySuccessRecord,
  redactDeployDiagnosticText,
} from './deploy-domain.ts'
import type { WorkflowReportRecord } from './mod.ts'

const workflowReportRecordLineMarker = 'WORKFLOW_REPORT_V1: ' as const

const decodeInputEither = Schema.decodeUnknownEither(DeployInputV1)
const decodeResultEither = Schema.decodeUnknownEither(DeployResultV1)

export type NetlifyDeployCommandOptions = {
  readonly target: string
  readonly artifactDir: string
  readonly mode: 'prod' | 'pr' | 'draft'
  readonly displayName?: string | undefined
  readonly pr?: number | undefined
  readonly siteName?: string | undefined
  readonly siteIdEnv: string
  readonly authTokenEnv: string
  readonly accountSlugEnv?: string | undefined
  readonly workflowReportOutputFile?: string | undefined
  readonly netlifyBin: string
  readonly netlifyApiBaseUrl: string
  readonly createdAtUtc?: string | undefined
  readonly e2eAllowSharedProject: boolean
  readonly e2eReservedAliasPrefix: string
}

const HttpsUrlString = Schema.NonEmptyTrimmedString.pipe(
  Schema.pattern(/^https:\/\/[^\s]+$/u),
  Schema.annotations({ identifier: 'CiTools.Netlify.HttpsUrlString' }),
)

const NetlifyDeployJson = Schema.Struct({
  deploy_id: Schema.NonEmptyTrimmedString,
  site_name: Schema.NonEmptyTrimmedString,
  deploy_url: HttpsUrlString,
}).annotations({ identifier: 'CiTools.Netlify.DeployJson' })

const NetlifySiteJson = Schema.Struct({
  name: Schema.optional(Schema.NonEmptyTrimmedString),
  account_slug: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'CiTools.Netlify.SiteJson' })

const isoNow = () => new Date().toISOString()

const optional = (value: string | undefined) =>
  value === undefined || value.trim().length === 0 ? undefined : value

const envValue = (envName: string) => optional(process.env[envName])

const netlifyAlias = Effect.fn('ci-tools.deploy.netlify.alias')(function* (opts: {
  readonly mode: 'prod' | 'pr' | 'draft'
  readonly target: string
  readonly pr?: number | undefined
}) {
  switch (opts.mode) {
    case 'prod':
      return opts.target
    case 'pr':
      if (opts.pr === undefined) {
        return yield* new ProviderOperationFailed({
          provider: 'netlify',
          target: opts.target,
          operation: 'deploy',
          transient: false,
          message: 'Netlify PR deploy requires --pr',
        })
      }
      return `${opts.target}-pr-${opts.pr}`
    case 'draft':
      return undefined
  }
})

const decodeDeployInput = Effect.fn('ci-tools.deploy.netlify.decode-input')(function* (
  value: unknown,
) {
  const decoded = decodeInputEither(value)
  if (Either.isRight(decoded) === true) return decoded.right
  return yield* new InvalidProviderOutput({
    provider: 'netlify',
    target:
      typeof value === 'object' &&
      value !== null &&
      'target' in value &&
      typeof value.target === 'string'
        ? value.target
        : 'netlify',
    outputKind: 'provider-response',
    message: 'Netlify deploy input did not match the ci-tools schema',
    diagnostics: { cause: String(decoded.left) },
  })
})

const assertSafeE2EAlias = Effect.fn('ci-tools.deploy.netlify.e2e-alias')(function* (opts: {
  readonly target: string
  readonly alias: string | undefined
  readonly allowSharedProject: boolean
  readonly reservedAliasPrefix: string
}) {
  if (opts.allowSharedProject === false || opts.alias === undefined) return
  if (opts.alias.startsWith(opts.reservedAliasPrefix) === true) return
  return yield* new UnsafeE2EAlias({
    provider: 'netlify',
    target: opts.target,
    alias: opts.alias,
    reservedAliasPrefix: opts.reservedAliasPrefix,
    message: `Netlify live E2E alias must start with ${opts.reservedAliasPrefix}`,
  })
})

const runNetlifyCommand = Effect.fn('ci-tools.deploy.netlify.command')(
  (opts: {
    readonly netlifyBin: string
    readonly args: readonly string[]
    readonly env?: Readonly<Record<string, string>> | undefined
  }) =>
    Effect.sync(() => {
      const result = spawnSync(opts.netlifyBin, opts.args, {
        encoding: 'utf8',
        env: { ...process.env, ...opts.env },
      })
      return {
        status: typeof result.status === 'number' ? result.status : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? String(result.error?.message ?? ''),
      }
    }),
)

const fetchNetlifyJson = Effect.fn('ci-tools.deploy.netlify.fetch-json')(function* (opts: {
  readonly target: string
  readonly apiBaseUrl: string
  readonly authToken: string
  readonly path: string
}) {
  return yield* Effect.tryPromise({
    try: async () => {
      const response = (await globalThis.fetch(
        `${opts.apiBaseUrl.replace(/\/+$/u, '')}${opts.path}`,
        {
          headers: { Authorization: `Bearer ${opts.authToken}`, Connection: 'close' },
        },
      )) as unknown as { readonly status: number; readonly text: () => Promise<string> }
      const text = await response.text()
      return { status: response.status, text }
    },
    catch: (cause) =>
      new ProviderProjectLookupFailed({
        provider: 'netlify',
        target: opts.target,
        transient: true,
        message: cause instanceof Error ? cause.message : 'Netlify API lookup failed',
      }),
  })
})

const resolveNetlifySite = Effect.fn('ci-tools.deploy.netlify.resolve-site')(function* (opts: {
  readonly target: string
  readonly siteId: string | undefined
  readonly authToken: string
  readonly apiBaseUrl: string
}) {
  if (opts.siteId === undefined) return {}
  const response = yield* fetchNetlifyJson({
    target: opts.target,
    apiBaseUrl: opts.apiBaseUrl,
    authToken: opts.authToken,
    path: `/api/v1/sites/${encodeURIComponent(opts.siteId)}`,
  })

  if (response.status === 401 || response.status === 403) {
    return yield* new Unauthorized({
      provider: 'netlify',
      target: opts.target,
      message: 'Netlify API rejected deploy credentials',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status === 404) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify site was not found',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status >= 500) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: true,
      message: 'Netlify site lookup returned a transient provider error',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify site lookup failed',
      diagnostics: { apiStatus: String(response.status) },
    })
  }

  const decoded = Schema.decodeUnknownEither(Schema.parseJson(NetlifySiteJson))(response.text)
  if (Either.isLeft(decoded) === true) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify site lookup returned invalid JSON',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  return {
    siteName: decoded.right.name,
    accountSlug: decoded.right.account_slug,
  }
})

const classifyNetlifyDeployFailure = (opts: {
  readonly target: string
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly authToken: string
}) => {
  const sanitizedStderr = redactDeployDiagnosticText(opts.stderr, {
    secretValues: [opts.authToken],
  }).trim()
  const sanitizedStdout = redactDeployDiagnosticText(opts.stdout, {
    secretValues: [opts.authToken],
  }).trim()
  const diagnostics = {
    exitCode: String(opts.status),
    ...(sanitizedStderr.trim().length === 0 ? {} : { stderr: sanitizedStderr }),
    ...(sanitizedStdout.trim().length === 0 ? {} : { stdout: sanitizedStdout }),
  }
  if (
    opts.stderr.includes('Project not found. Please rerun "netlify link"') === true ||
    opts.stderr.includes('Project not found. Please rerun netlify link') === true
  ) {
    return new ProviderProjectLookupFailed({
      provider: 'netlify',
      target: opts.target,
      transient: false,
      message: 'Netlify project lookup failed',
      diagnostics,
    })
  }
  if (opts.stderr.includes('Unauthorized: could not retrieve project') === true) {
    return new Unauthorized({
      provider: 'netlify',
      target: opts.target,
      message: 'Netlify credentials could not retrieve the configured project',
      diagnostics,
    })
  }
  if (/unauthorized|forbidden|invalid token/iu.test(opts.stderr) === true) {
    return new Unauthorized({
      provider: 'netlify',
      target: opts.target,
      message: 'Netlify rejected deploy credentials',
      diagnostics,
    })
  }
  return new ProviderOperationFailed({
    provider: 'netlify',
    target: opts.target,
    operation: 'deploy',
    transient: opts.status >= 500,
    message: 'Netlify deploy command failed',
    diagnostics,
  })
}

const parseDeployJson = Effect.fn('ci-tools.deploy.netlify.parse-json')(function* (opts: {
  readonly target: string
  readonly stdout: string
  readonly authToken: string
}) {
  const decoded = Schema.decodeUnknownEither(Schema.parseJson(NetlifyDeployJson))(opts.stdout)
  if (Either.isRight(decoded) === true) {
    return decoded.right
  }
  const sanitizedStdout = redactDeployDiagnosticText(opts.stdout, {
    secretValues: [opts.authToken],
  }).trim()
  return yield* new InvalidProviderOutput({
    provider: 'netlify',
    target: opts.target,
    outputKind: 'json',
    message: 'Netlify CLI did not return deploy_id, site_name, and deploy_url',
    diagnostics: sanitizedStdout.length === 0 ? undefined : { stdout: sanitizedStdout },
  })
})

const emitRecord = (opts: {
  readonly record: WorkflowReportRecord
  readonly workflowReportOutputFile: string | undefined
}) =>
  Effect.gen(function* () {
    const encodedRecord = yield* Schema.encode(Schema.parseJson(Schema.Unknown))(opts.record)
    yield* Effect.sync(() => {
      const line = `${workflowReportRecordLineMarker}${encodedRecord}\n`
      process.stdout.write(line)
      if (opts.workflowReportOutputFile !== undefined) {
        appendFileSync(opts.workflowReportOutputFile, line)
      }
    })
  })

export const runNetlifyDeploy = Effect.fn('ci-tools.deploy.netlify')(function* (
  options: NetlifyDeployCommandOptions,
) {
  const createdAtUtc = options.createdAtUtc ?? isoNow()
  const alias = yield* netlifyAlias({ mode: options.mode, target: options.target, pr: options.pr })

  const input = yield* decodeDeployInput({
    _tag: 'DeployInput',
    schemaVersion: 1,
    provider: 'netlify',
    target: options.target,
    displayName: options.displayName,
    mode: options.mode,
    artifactDir: options.artifactDir,
    alias,
    pr: options.pr,
    workflowReportOutputFile: options.workflowReportOutputFile,
    e2e: {
      _tag: 'DeployE2EConfig',
      enabled: options.e2eAllowSharedProject,
      allowSharedProject: options.e2eAllowSharedProject,
      reservedAliasPrefix: options.e2eReservedAliasPrefix,
    },
    providerConfig: {
      _tag: 'NetlifyProviderConfig',
      siteName: options.siteName,
      siteIdEnv: options.siteIdEnv,
      authTokenEnv: options.authTokenEnv,
      accountSlugEnv: options.accountSlugEnv,
    },
  })

  const authTokenValue = envValue(options.authTokenEnv)
  const failWithRecord = (failure: DeployFailure) =>
    emitRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deployFailureRecord({
        input,
        failure,
        attempts: 1,
        createdAtUtc,
        secretValues: authTokenValue === undefined ? [] : [authTokenValue],
      }),
    }).pipe(Effect.zipRight(Effect.fail(failure)))

  yield* assertSafeE2EAlias({
    target: options.target,
    alias,
    allowSharedProject: options.e2eAllowSharedProject,
    reservedAliasPrefix: options.e2eReservedAliasPrefix,
  }).pipe(Effect.catchAll(failWithRecord))

  if (existsSync(options.artifactDir) === false) {
    yield* emitRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deploySkippedRecord({
        input,
        reason: `No local artifact was produced for ${options.target}`,
        createdAtUtc,
      }),
    })
    return
  }

  if (authTokenValue === undefined) {
    return yield* failWithRecord(
      new MissingAuth({
        provider: 'netlify',
        target: options.target,
        envVar: options.authTokenEnv,
        message: `Missing ${options.authTokenEnv}`,
      }),
    )
  }

  const siteId = envValue(options.siteIdEnv)
  const resolvedSite = yield* resolveNetlifySite({
    target: options.target,
    siteId,
    authToken: authTokenValue,
    apiBaseUrl: options.netlifyApiBaseUrl,
  }).pipe(Effect.catchAll(failWithRecord))

  const siteName = options.siteName ?? resolvedSite.siteName
  const args = [
    'deploy',
    `--dir=${options.artifactDir}`,
    `--auth=${authTokenValue}`,
    '--no-build',
    ...(siteId === undefined && siteName !== undefined ? [`--site=${siteName}`] : []),
    ...(alias === undefined ? [] : [`--alias=${alias}`]),
    `--message=${options.target} (${options.mode})`,
    '--json',
  ]
  const result = yield* DeployProviderOperation.with({
    attributes: {
      provider: 'netlify',
      target: input.target,
    },
    effect: runNetlifyCommand({
      netlifyBin: options.netlifyBin,
      args,
      env: siteId === undefined ? undefined : { NETLIFY_SITE_ID: siteId },
    }),
  })

  if (result.status !== 0) {
    return yield* failWithRecord(
      classifyNetlifyDeployFailure({
        target: options.target,
        status: result.status,
        stdout: result.stdout,
        stderr: result.stderr,
        authToken: authTokenValue,
      }),
    )
  }

  const deployJson = yield* parseDeployJson({
    target: options.target,
    stdout: result.stdout,
    authToken: authTokenValue,
  }).pipe(Effect.catchAll(failWithRecord))
  const finalSiteName = siteName ?? deployJson.site_name
  const finalUrl =
    alias === undefined ? deployJson.deploy_url : `https://${alias}--${finalSiteName}.netlify.app`
  const decoded = decodeResultEither({
    _tag: 'DeployResult',
    schemaVersion: 1,
    provider: 'netlify',
    target: options.target,
    mode: options.mode,
    deployId: deployJson.deploy_id,
    rawDeployUrl: `https://${deployJson.deploy_id}--${deployJson.site_name}.netlify.app`,
    finalUrl,
    alias,
    startedAtUtc: createdAtUtc,
    endedAtUtc: isoNow(),
    attempts: 1,
  })

  if (Either.isLeft(decoded) === true) {
    return yield* failWithRecord(
      new InvalidProviderOutput({
        provider: 'netlify',
        target: options.target,
        outputKind: 'provider-response',
        message: 'Netlify deploy result did not match the ci-tools schema',
        diagnostics: { finalUrl },
      }),
    )
  }

  process.stdout.write(`Netlify deploy URL: ${finalUrl}\n`)
  yield* emitRecord({
    workflowReportOutputFile: options.workflowReportOutputFile,
    record: deploySuccessRecord({
      input,
      result: decoded.right,
      createdAtUtc,
    }),
  })
})
