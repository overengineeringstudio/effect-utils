/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args, overeng/exports-first -- Phase 4 exposes the Vercel deploy boundary used by generated tasks; helper definitions stay before the exported Effect entrypoint for reviewability. */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HttpClient, HttpClientRequest } from '@effect/platform'
import { Effect, Either, Schema } from 'effect'

import {
  DeployInputV1,
  type CleanupResult,
  type DeployFailure,
  DeployProviderOperation,
  DeployResultV1,
  DeployVerifyOperation,
  InvalidProviderOutput,
  MissingAuth,
  MissingBuildOutput,
  ProviderOperationFailed,
  ProviderProjectLookupFailed,
  Unauthorized,
  UnsafeE2EAlias,
  VerificationFailed,
  deployFailureRecord,
  deploySuccessRecord,
  redactDeployDiagnosticText,
} from './deploy-domain.ts'
import {
  emitWorkflowReportRecord,
  writeDevenvTaskOutput,
  writeGithubDeployOutputs,
} from './deploy-io.ts'

const decodeInputEither = Schema.decodeUnknownEither(DeployInputV1)
const decodeResultEither = Schema.decodeUnknownEither(DeployResultV1)

export type VercelDeployCommandOptions = {
  readonly target: string
  readonly artifactDir: string
  readonly artifactKind: 'static' | 'prebuilt-output'
  readonly mode: 'prod' | 'pr' | 'preview'
  readonly displayName?: string | undefined
  readonly pr?: number | undefined
  readonly aliasPrefix?: string | undefined
  readonly aliasSuffix?: string | undefined
  readonly projectIdEnv: string
  readonly orgIdEnv: string
  readonly authTokenEnv: string
  readonly teamIdEnv?: string | undefined
  readonly scopeEnv?: string | undefined
  readonly protectionBypassEnv?: string | undefined
  readonly workflowReportOutputFile?: string | undefined
  readonly githubOutputFile?: string | undefined
  readonly githubEnvFile?: string | undefined
  readonly urlEnvKey?: string | undefined
  readonly buildPrebuiltOutput: boolean
  readonly vercelRootDirectory?: string | undefined
  readonly buildEnv: readonly string[]
  readonly vercelBin: string
  readonly vercelApiBaseUrl: string
  readonly createdAtUtc?: string | undefined
  readonly e2eAllowSharedProject: boolean
  readonly e2eReservedAliasPrefix: string
  readonly e2eVerifyPath?: string | undefined
  readonly e2eVerifyText?: string | undefined
}

const VercelProjectJson = Schema.Struct({
  id: Schema.optional(Schema.NonEmptyTrimmedString),
  name: Schema.optional(Schema.NonEmptyTrimmedString),
}).annotations({ identifier: 'CiTools.Vercel.ProjectJson' })

const VercelProjectFileJson = Schema.parseJson(
  Schema.Struct({
    projectId: Schema.NonEmptyTrimmedString,
    orgId: Schema.NonEmptyTrimmedString,
  }),
)
const JsonUnknown = Schema.parseJson(Schema.Unknown)

const isoNow = () => new Date().toISOString()

const optional = (value: string | undefined) =>
  value === undefined || value.trim().length === 0 ? undefined : value

const envValue = (envName: string) => optional(process.env[envName])

const vercelAlias = Effect.fn('ci-tools.deploy.vercel.alias')(function* (opts: {
  readonly mode: 'prod' | 'pr' | 'preview'
  readonly target: string
  readonly pr?: number | undefined
  readonly aliasSuffix?: string | undefined
}) {
  const suffix = opts.aliasSuffix === undefined ? '' : `-${opts.aliasSuffix}`
  switch (opts.mode) {
    case 'prod':
      return `${opts.target}${suffix}`
    case 'pr':
      if (opts.pr === undefined) {
        return yield* new ProviderOperationFailed({
          provider: 'vercel',
          target: opts.target,
          operation: 'deploy',
          transient: false,
          message: 'Vercel PR deploy requires --pr',
        })
      }
      return `${opts.target}-pr-${opts.pr}${suffix}`
    case 'preview':
      return undefined
  }
})

const decodeDeployInput = Effect.fn('ci-tools.deploy.vercel.decode-input')(function* (
  value: unknown,
) {
  const decoded = decodeInputEither(value)
  if (Either.isRight(decoded) === true) return decoded.right
  return yield* new InvalidProviderOutput({
    provider: 'vercel',
    target:
      typeof value === 'object' &&
      value !== null &&
      'target' in value &&
      typeof value.target === 'string'
        ? value.target
        : 'vercel',
    outputKind: 'provider-response',
    message: 'Vercel deploy input did not match the ci-tools schema',
    diagnostics: { cause: String(decoded.left) },
  })
})

const assertSafeE2EAlias = Effect.fn('ci-tools.deploy.vercel.e2e-alias')(function* (opts: {
  readonly target: string
  readonly alias: string | undefined
  readonly allowSharedProject: boolean
  readonly reservedAliasPrefix: string
}) {
  if (opts.allowSharedProject === false || opts.alias === undefined) return
  if (opts.alias.startsWith(opts.reservedAliasPrefix) === true) return
  return yield* new UnsafeE2EAlias({
    provider: 'vercel',
    target: opts.target,
    alias: opts.alias,
    reservedAliasPrefix: opts.reservedAliasPrefix,
    message: `Vercel live E2E alias must start with ${opts.reservedAliasPrefix}`,
  })
})

const vercelCommandMaxBufferBytes = 64 * 1024 * 1024

const runVercelCommand = Effect.fn('ci-tools.deploy.vercel.command')(
  (opts: {
    readonly vercelBin: string
    readonly args: readonly string[]
    readonly cwd: string
    readonly env?: Readonly<Record<string, string>> | undefined
  }) =>
    Effect.sync(() => {
      const result = spawnSync(opts.vercelBin, opts.args, {
        cwd: opts.cwd,
        encoding: 'utf8',
        env: { ...process.env, ...opts.env },
        maxBuffer: vercelCommandMaxBufferBytes,
      })
      return {
        status: typeof result.status === 'number' ? result.status : 1,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? String(result.error?.message ?? ''),
      }
    }),
)

const vercelScopeArgs = (scope: string | undefined) =>
  scope === undefined ? [] : ['--scope', scope]

const buildEnvRecord = Effect.fn('ci-tools.deploy.vercel.build-env')(function* (opts: {
  readonly target: string
  readonly entries: readonly string[]
}) {
  const env: Record<string, string> = {}
  for (const entry of opts.entries) {
    const separator = entry.indexOf('=')
    if (separator <= 0) {
      return yield* new ProviderOperationFailed({
        provider: 'vercel',
        target: opts.target,
        operation: 'prepare',
        transient: false,
        message: `Invalid --build-env entry: ${entry}`,
      })
    }
    env[entry.slice(0, separator)] = entry.slice(separator + 1)
  }
  return env
})

const fetchVercelJson = Effect.fn('ci-tools.deploy.vercel.fetch-json')(function* (opts: {
  readonly target: string
  readonly apiBaseUrl: string
  readonly authToken: string
  readonly path: string
}) {
  const client = yield* HttpClient.HttpClient
  return yield* client
    .execute(
      HttpClientRequest.get(`${opts.apiBaseUrl.replace(/\/+$/u, '')}${opts.path}`).pipe(
        HttpClientRequest.setHeader('Authorization', `Bearer ${opts.authToken}`),
        HttpClientRequest.setHeader('Connection', 'close'),
      ),
    )
    .pipe(
      Effect.flatMap((response) =>
        response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
      ),
      Effect.catchTags({
        RequestError: (cause) =>
          new ProviderProjectLookupFailed({
            provider: 'vercel',
            target: opts.target,
            transient: true,
            message: cause.message,
          }),
        ResponseError: (cause) =>
          new ProviderProjectLookupFailed({
            provider: 'vercel',
            target: opts.target,
            transient: true,
            message: cause.message,
          }),
      }),
    )
})

const resolveVercelProject = Effect.fn('ci-tools.deploy.vercel.resolve-project')(function* (opts: {
  readonly target: string
  readonly projectId: string
  readonly orgId: string
  readonly teamId: string | undefined
  readonly authToken: string
  readonly apiBaseUrl: string
}) {
  const teamId = opts.teamId ?? opts.orgId
  const response = yield* fetchVercelJson({
    target: opts.target,
    apiBaseUrl: opts.apiBaseUrl,
    authToken: opts.authToken,
    path: `/v9/projects/${encodeURIComponent(opts.projectId)}?teamId=${encodeURIComponent(teamId)}`,
  })

  if (response.status === 401 || response.status === 403) {
    return yield* new Unauthorized({
      provider: 'vercel',
      target: opts.target,
      message: 'Vercel API rejected deploy credentials',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status === 404) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'vercel',
      target: opts.target,
      transient: false,
      message: 'Vercel project was not found',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status >= 500) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'vercel',
      target: opts.target,
      transient: true,
      message: 'Vercel project lookup returned a transient provider error',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'vercel',
      target: opts.target,
      transient: false,
      message: 'Vercel project lookup failed',
      diagnostics: { apiStatus: String(response.status) },
    })
  }

  const decoded = Schema.decodeUnknownEither(Schema.parseJson(VercelProjectJson))(response.text)
  if (Either.isLeft(decoded) === true) {
    return yield* new ProviderProjectLookupFailed({
      provider: 'vercel',
      target: opts.target,
      transient: false,
      message: 'Vercel project lookup returned invalid JSON',
      diagnostics: { apiStatus: String(response.status) },
    })
  }
  return decoded.right
})

const copyStaticDirectory = Effect.fn('ci-tools.deploy.vercel.copy-static')(function* (opts: {
  readonly artifactDir: string
  readonly outputStaticDir: string
}) {
  yield* Effect.sync(() => {
    mkdirSync(opts.outputStaticDir, { recursive: true })
    for (const entry of readdirSync(opts.artifactDir, { withFileTypes: true })) {
      cpSync(join(opts.artifactDir, entry.name), join(opts.outputStaticDir, entry.name), {
        recursive: true,
      })
    }
  })
})

const preparePrebuiltOutput = Effect.fn('ci-tools.deploy.vercel.prepare-prebuilt')(
  function* (opts: {
    readonly artifactDir: string
    readonly artifactKind: 'static' | 'prebuilt-output'
    readonly projectId: string
    readonly orgId: string
  }) {
    const workDir = yield* Effect.sync(() => mkdtempSync(join(tmpdir(), 'ci-tools-vercel-')))
    const projectJson = yield* Schema.encode(VercelProjectFileJson)({
      projectId: opts.projectId,
      orgId: opts.orgId,
    })
    yield* Effect.sync(() => {
      mkdirSync(join(workDir, '.vercel', 'output'), { recursive: true })
      writeFileSync(join(workDir, '.vercel', 'output', 'config.json'), '{"version":3}\n')
      writeFileSync(join(workDir, '.vercel', 'project.json'), `${projectJson}\n`)
    })
    if (opts.artifactKind === 'static') {
      yield* copyStaticDirectory({
        artifactDir: opts.artifactDir,
        outputStaticDir: join(workDir, '.vercel', 'output', 'static'),
      })
    } else {
      yield* Effect.sync(() => {
        rmSync(join(workDir, '.vercel', 'output'), { recursive: true, force: true })
        cpSync(opts.artifactDir, join(workDir, '.vercel', 'output'), { recursive: true })
      })
    }
    return workDir
  },
)

const patchProjectRootDirectory = Effect.fn('ci-tools.deploy.vercel.patch-root-directory')(
  function* (opts: { readonly target: string; readonly rootDirectory: string | undefined }) {
    if (opts.rootDirectory === undefined || opts.rootDirectory === '.') return
    const projectJsonPath = join('.vercel', 'project.json')
    if (existsSync(projectJsonPath) === false) return
    const decodedJson = Schema.decodeUnknownEither(JsonUnknown)(
      readFileSync(projectJsonPath, 'utf8'),
    )
    if (Either.isLeft(decodedJson) === true) {
      return yield* new ProviderOperationFailed({
        provider: 'vercel',
        target: opts.target,
        operation: 'prepare',
        transient: false,
        message: 'Vercel project.json could not be decoded',
        diagnostics: { cause: String(decodedJson.left) },
      })
    }
    const decoded = decodedJson.right
    const projectJson =
      typeof decoded === 'object' && decoded !== null && Array.isArray(decoded) === false
        ? decoded
        : {}
    const rawSettings = 'settings' in projectJson ? projectJson.settings : undefined
    const settings =
      typeof rawSettings === 'object' &&
      rawSettings !== null &&
      Array.isArray(rawSettings) === false
        ? rawSettings
        : {}
    const encodedJson = Schema.encodeEither(JsonUnknown)({
      ...projectJson,
      settings: {
        ...settings,
        rootDirectory: opts.rootDirectory,
      },
    })
    if (Either.isLeft(encodedJson) === true) {
      return yield* new ProviderOperationFailed({
        provider: 'vercel',
        target: opts.target,
        operation: 'prepare',
        transient: false,
        message: 'Vercel project.json could not be encoded',
        diagnostics: { cause: String(encodedJson.left) },
      })
    }
    yield* Effect.sync(() => {
      writeFileSync(projectJsonPath, `${encodedJson.right}\n`)
    })
  },
)

const withTemporaryInstallCommand = Effect.fn('ci-tools.deploy.vercel.install-command')(function* <
  A,
  E,
  R,
>(opts: {
  readonly target: string
  readonly rootDirectory: string
  readonly effect: Effect.Effect<A, E, R>
}) {
  const vercelJsonPath = join(opts.rootDirectory, 'vercel.json')
  const original =
    existsSync(vercelJsonPath) === true ? readFileSync(vercelJsonPath, 'utf8') : undefined
  const base =
    original === undefined
      ? Either.right({})
      : (() => {
          const decodedJson = Schema.decodeUnknownEither(JsonUnknown)(original)
          if (Either.isLeft(decodedJson) === true) return decodedJson
          const decoded = decodedJson.right
          return Either.right(
            typeof decoded === 'object' && decoded !== null && Array.isArray(decoded) === false
              ? decoded
              : {},
          )
        })()
  if (Either.isLeft(base) === true) {
    return yield* new ProviderOperationFailed({
      provider: 'vercel',
      target: opts.target,
      operation: 'prepare',
      transient: false,
      message: 'Vercel vercel.json could not be decoded',
      diagnostics: { cause: String(base.left) },
    })
  }
  const updatedJson = Schema.encodeEither(JsonUnknown)({ ...base.right, installCommand: 'true' })
  if (Either.isLeft(updatedJson) === true) {
    return yield* new ProviderOperationFailed({
      provider: 'vercel',
      target: opts.target,
      operation: 'prepare',
      transient: false,
      message: 'Vercel vercel.json could not be encoded',
      diagnostics: { cause: String(updatedJson.left) },
    })
  }
  const updated = updatedJson.right
  yield* Effect.sync(() => {
    if (original === undefined) {
      mkdirSync(opts.rootDirectory, { recursive: true })
      writeFileSync(vercelJsonPath, `${updated}\n`)
      return
    }
    writeFileSync(vercelJsonPath, `${updated}\n`)
  })
  return yield* opts.effect.pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (original === undefined) {
          rmSync(vercelJsonPath, { force: true })
        } else {
          writeFileSync(vercelJsonPath, original)
        }
      }),
    ),
  )
})

const prepareLocalPrebuiltOutput = Effect.fn('ci-tools.deploy.vercel.prepare-local-prebuilt')(
  function* (opts: {
    readonly target: string
    readonly mode: 'prod' | 'pr' | 'preview'
    readonly artifactDir: string
    readonly rootDirectory: string | undefined
    readonly vercelBin: string
    readonly authToken: string
    readonly projectId: string
    readonly orgId: string
    readonly teamId: string | undefined
    readonly scope: string | undefined
    readonly buildEnv: Readonly<Record<string, string>>
  }) {
    const pullEnvironment = opts.mode === 'prod' ? 'production' : 'preview'
    const buildArgs = [
      'build',
      '--yes',
      ...(opts.mode === 'prod' ? ['--prod'] : []),
      ...vercelScopeArgs(opts.scope),
      '--token',
      opts.authToken,
    ]
    const commandEnv = {
      ...opts.buildEnv,
      VERCEL_PROJECT_ID: opts.projectId,
      VERCEL_ORG_ID: opts.orgId,
      ...(opts.teamId === undefined ? {} : { VERCEL_TEAM_ID: opts.teamId }),
    }

    process.stdout.write(
      `Pulling Vercel project settings and env for ${opts.target} (${pullEnvironment})...\n`,
    )
    const pullResult = yield* runVercelCommand({
      vercelBin: opts.vercelBin,
      cwd: process.cwd(),
      args: [
        'pull',
        '--yes',
        '--environment',
        pullEnvironment,
        ...vercelScopeArgs(opts.scope),
        '--token',
        opts.authToken,
      ],
      env: commandEnv,
    })
    if (pullResult.status !== 0) {
      return yield* classifyVercelFailure({
        target: opts.target,
        status: pullResult.status,
        stdout: pullResult.stdout,
        stderr: pullResult.stderr,
        authToken: opts.authToken,
        operation: 'prepare',
      })
    }

    yield* patchProjectRootDirectory({ target: opts.target, rootDirectory: opts.rootDirectory })

    process.stdout.write(`Building ${opts.target} locally with vercel build...\n`)
    const rootDirectory = opts.rootDirectory ?? '.'
    const buildResult = yield* withTemporaryInstallCommand({
      target: opts.target,
      rootDirectory,
      effect: runVercelCommand({
        vercelBin: opts.vercelBin,
        cwd: process.cwd(),
        args: buildArgs,
        env: commandEnv,
      }),
    })
    if (buildResult.status !== 0) {
      return yield* classifyVercelFailure({
        target: opts.target,
        status: buildResult.status,
        stdout: buildResult.stdout,
        stderr: buildResult.stderr,
        authToken: opts.authToken,
        operation: 'prepare',
      })
    }

    if (
      existsSync(opts.artifactDir) === false ||
      statSync(opts.artifactDir).isDirectory() === false
    ) {
      return yield* new MissingBuildOutput({
        provider: 'vercel',
        target: opts.target,
        artifactDir: opts.artifactDir,
        message: `Missing local Vercel prebuilt output at ${opts.artifactDir}`,
      })
    }
  },
)

const extractDeployUrl = (stdout: string) =>
  stdout.match(/https:\/\/[^\s"]+\.vercel\.app(?:\/[^\s"]*)?/u)?.[0]

const classifyVercelFailure = (opts: {
  readonly target: string
  readonly status: number
  readonly stdout: string
  readonly stderr: string
  readonly authToken: string
  readonly operation: 'prepare' | 'deploy' | 'alias' | 'cleanup'
}) => {
  const sanitizedStderr = redactDeployDiagnosticText(opts.stderr, {
    secretValues: [opts.authToken],
  }).trim()
  const sanitizedStdout = redactDeployDiagnosticText(opts.stdout, {
    secretValues: [opts.authToken],
  }).trim()
  const diagnostics = {
    exitCode: String(opts.status),
    ...(sanitizedStderr.length === 0 ? {} : { stderr: sanitizedStderr }),
    ...(sanitizedStdout.length === 0 ? {} : { stdout: sanitizedStdout }),
  }
  if (/unauthorized|forbidden|invalid token|not authorized/iu.test(opts.stderr) === true) {
    return new Unauthorized({
      provider: 'vercel',
      target: opts.target,
      message: 'Vercel rejected deploy credentials',
      diagnostics,
    })
  }
  if (
    /project not found|could not find project|not linked/iu.test(
      `${opts.stderr}\n${opts.stdout}`,
    ) === true
  ) {
    return new ProviderProjectLookupFailed({
      provider: 'vercel',
      target: opts.target,
      transient: false,
      message: 'Vercel project lookup failed',
      diagnostics,
    })
  }
  return new ProviderOperationFailed({
    provider: 'vercel',
    target: opts.target,
    operation: opts.operation,
    transient: opts.status >= 500,
    message: `Vercel ${opts.operation} command failed`,
    diagnostics,
  })
}

const verifyFinalUrlOnce = Effect.fn('ci-tools.deploy.vercel.verify-once')(function* (opts: {
  readonly target: string
  readonly finalUrl: URL
  readonly path: string
  readonly expectedText: string
  readonly attempt: number
  readonly protectionBypass: string | undefined
}) {
  const verifyUrl = new URL(opts.path, opts.finalUrl)
  const client = yield* HttpClient.HttpClient
  const baseRequest = HttpClientRequest.get(verifyUrl.toString()).pipe(
    HttpClientRequest.setHeader('Connection', 'close'),
  )
  const request =
    opts.protectionBypass === undefined
      ? baseRequest
      : baseRequest.pipe(
          HttpClientRequest.setHeader('x-vercel-protection-bypass', opts.protectionBypass),
        )
  const response = yield* client.execute(request).pipe(
    Effect.flatMap((result) =>
      result.text.pipe(Effect.map((text) => ({ status: result.status, text }))),
    ),
    Effect.catchTags({
      RequestError: (cause) =>
        new VerificationFailed({
          provider: 'vercel',
          target: opts.target,
          finalUrl: opts.finalUrl,
          transient: true,
          message: cause.message,
          diagnostics: { attempt: String(opts.attempt), verifyPath: opts.path },
        }),
      ResponseError: (cause) =>
        new VerificationFailed({
          provider: 'vercel',
          target: opts.target,
          finalUrl: opts.finalUrl,
          transient: true,
          message: cause.message,
          diagnostics: { attempt: String(opts.attempt), verifyPath: opts.path },
        }),
    }),
  )

  if (response.status < 200 || response.status >= 300) {
    return yield* new VerificationFailed({
      provider: 'vercel',
      target: opts.target,
      finalUrl: opts.finalUrl,
      transient: response.status >= 500,
      message: `Vercel live E2E verification returned HTTP ${response.status}`,
      diagnostics: { attempt: String(opts.attempt), httpStatus: String(response.status) },
    })
  }

  if (response.text.includes(opts.expectedText) === false) {
    return yield* new VerificationFailed({
      provider: 'vercel',
      target: opts.target,
      finalUrl: opts.finalUrl,
      transient: false,
      message: 'Vercel live E2E marker text was not served',
      diagnostics: { attempt: String(opts.attempt), verifyPath: opts.path },
    })
  }
})

const verifyFinalUrl = Effect.fn('ci-tools.deploy.vercel.verify')(function* (opts: {
  readonly target: string
  readonly finalUrl: URL
  readonly path: string
  readonly expectedText: string
  readonly protectionBypass: string | undefined
}) {
  let lastFailure: VerificationFailed | undefined
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const result = yield* DeployVerifyOperation.with({
      attributes: {
        provider: 'vercel',
        target: opts.target,
        status: 'failure',
        urlHost: opts.finalUrl.host,
      },
      effect: verifyFinalUrlOnce({ ...opts, attempt }),
    }).pipe(
      Effect.catchTag(
        'OtelAttrEncodeError',
        (cause) =>
          new VerificationFailed({
            provider: 'vercel',
            target: opts.target,
            finalUrl: opts.finalUrl,
            transient: false,
            message: cause.message,
          }),
      ),
      Effect.either,
    )
    if (Either.isRight(result) === true) return
    lastFailure = result.left
    if (attempt < 10) {
      yield* Effect.sleep('2 seconds')
    }
  }
  return yield* (
    lastFailure ??
      new VerificationFailed({
        provider: 'vercel',
        target: opts.target,
        finalUrl: opts.finalUrl,
        transient: true,
        message: 'Vercel live E2E verification did not complete',
      })
  )
})

const cleanupAlias = Effect.fn('ci-tools.deploy.vercel.cleanup-alias')(function* (opts: {
  readonly target: string
  readonly alias: string | undefined
  readonly allowSharedProject: boolean
  readonly workDir: string
  readonly vercelBin: string
  readonly authToken: string
  readonly projectId: string
  readonly orgId: string
  readonly teamId: string | undefined
  readonly scope: string | undefined
}) {
  if (opts.allowSharedProject === false || opts.alias === undefined) {
    return {
      _tag: 'CleanupResult',
      status: 'skipped',
      message: 'No shared-project Vercel alias cleanup requested',
    } satisfies CleanupResult
  }

  const aliasHost = `${opts.alias}.vercel.app`
  const result = yield* runVercelCommand({
    vercelBin: opts.vercelBin,
    cwd: opts.workDir,
    args: [
      'alias',
      'rm',
      aliasHost,
      '--yes',
      ...vercelScopeArgs(opts.scope),
      '--token',
      opts.authToken,
    ],
    env: {
      VERCEL_PROJECT_ID: opts.projectId,
      VERCEL_ORG_ID: opts.orgId,
      ...(opts.teamId === undefined ? {} : { VERCEL_TEAM_ID: opts.teamId }),
    },
  }).pipe(Effect.either)

  if (Either.isLeft(result) === true || result.right.status !== 0) {
    return {
      _tag: 'CleanupResult',
      status: 'failed',
      message: 'Vercel alias cleanup failed; deploy and verification results are preserved',
    } satisfies CleanupResult
  }
  return {
    _tag: 'CleanupResult',
    status: 'succeeded',
    message: 'Removed reserved Vercel live E2E alias',
  } satisfies CleanupResult
})

export const runVercelDeploy = Effect.fn('ci-tools.deploy.vercel')(function* (
  options: VercelDeployCommandOptions,
) {
  const createdAtUtc = options.createdAtUtc ?? isoNow()
  const alias = yield* vercelAlias({
    mode: options.mode,
    target: options.aliasPrefix ?? options.target,
    pr: options.pr,
    aliasSuffix: options.aliasSuffix,
  })

  const input = yield* decodeDeployInput({
    _tag: 'DeployInput',
    schemaVersion: 1,
    provider: 'vercel',
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
      ...(options.e2eVerifyPath === undefined || options.e2eVerifyText === undefined
        ? {}
        : {
            verifyContent: {
              _tag: 'DeployVerifyContent',
              path: options.e2eVerifyPath,
              expectedText: options.e2eVerifyText,
            },
          }),
    },
    providerConfig: {
      _tag: 'VercelProviderConfig',
      projectIdEnv: options.projectIdEnv,
      orgIdEnv: options.orgIdEnv,
      authTokenEnv: options.authTokenEnv,
      teamIdEnv: options.teamIdEnv,
      scopeEnv: options.scopeEnv,
      protectionBypassEnv: options.protectionBypassEnv,
    },
  })

  const authTokenValue = envValue(options.authTokenEnv)
  const failWithRecord = (failure: DeployFailure) =>
    emitWorkflowReportRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deployFailureRecord({
        input,
        failure,
        attempts: 1,
        createdAtUtc,
        secretValues: authTokenValue === undefined ? [] : [authTokenValue],
      }),
    }).pipe(Effect.zipRight(Effect.fail(failure)))

  if ((options.e2eVerifyPath === undefined) !== (options.e2eVerifyText === undefined)) {
    return yield* failWithRecord(
      new ProviderOperationFailed({
        provider: 'vercel',
        target: options.target,
        operation: 'verify',
        transient: false,
        message: 'Vercel live E2E verification requires both path and expected text',
      }),
    )
  }

  yield* assertSafeE2EAlias({
    target: options.target,
    alias,
    allowSharedProject: options.e2eAllowSharedProject,
    reservedAliasPrefix: options.e2eReservedAliasPrefix,
  }).pipe(Effect.catchAll(failWithRecord))

  if (authTokenValue === undefined) {
    return yield* failWithRecord(
      new MissingAuth({
        provider: 'vercel',
        target: options.target,
        envVar: options.authTokenEnv,
        message: `Missing ${options.authTokenEnv}`,
      }),
    )
  }
  const projectId = envValue(options.projectIdEnv)
  if (projectId === undefined) {
    return yield* failWithRecord(
      new ProviderProjectLookupFailed({
        provider: 'vercel',
        target: options.target,
        transient: false,
        message: `Missing ${options.projectIdEnv}`,
      }),
    )
  }
  const orgId = envValue(options.orgIdEnv)
  if (orgId === undefined) {
    return yield* failWithRecord(
      new ProviderProjectLookupFailed({
        provider: 'vercel',
        target: options.target,
        transient: false,
        message: `Missing ${options.orgIdEnv}`,
      }),
    )
  }
  const teamId = options.teamIdEnv === undefined ? undefined : envValue(options.teamIdEnv)
  const scope = options.scopeEnv === undefined ? undefined : envValue(options.scopeEnv)
  const protectionBypass =
    options.protectionBypassEnv === undefined ? undefined : envValue(options.protectionBypassEnv)
  const buildEnv = yield* buildEnvRecord({
    target: options.target,
    entries: options.buildEnv,
  }).pipe(Effect.catchAll(failWithRecord))

  if (options.buildPrebuiltOutput === true && options.artifactKind !== 'prebuilt-output') {
    return yield* failWithRecord(
      new ProviderOperationFailed({
        provider: 'vercel',
        target: options.target,
        operation: 'prepare',
        transient: false,
        message: 'Vercel --build-prebuilt-output requires --artifact-kind prebuilt-output',
      }),
    )
  }

  yield* resolveVercelProject({
    target: options.target,
    projectId,
    orgId,
    teamId,
    authToken: authTokenValue,
    apiBaseUrl: options.vercelApiBaseUrl,
  }).pipe(Effect.catchAll(failWithRecord))

  let cleanupLocalVercel = false
  try {
    if (options.buildPrebuiltOutput === true) {
      cleanupLocalVercel = true
      yield* prepareLocalPrebuiltOutput({
        target: options.target,
        mode: options.mode,
        artifactDir: options.artifactDir,
        rootDirectory: options.vercelRootDirectory,
        vercelBin: options.vercelBin,
        authToken: authTokenValue,
        projectId,
        orgId,
        teamId,
        scope,
        buildEnv,
      }).pipe(Effect.catchAll(failWithRecord))
    }

    if (
      existsSync(options.artifactDir) === false ||
      statSync(options.artifactDir).isDirectory() === false
    ) {
      return yield* failWithRecord(
        new MissingBuildOutput({
          provider: 'vercel',
          target: options.target,
          artifactDir: options.artifactDir,
          message: `Missing local Vercel ${
            options.artifactKind === 'static' ? 'static' : 'prebuilt'
          } output at ${options.artifactDir}`,
        }),
      )
    }

    const workDir = yield* preparePrebuiltOutput({
      artifactDir: options.artifactDir,
      artifactKind: options.artifactKind,
      projectId,
      orgId,
    })

    try {
      const deployResult = yield* DeployProviderOperation.with({
        attributes: {
          provider: 'vercel',
          target: input.target,
        },
        effect: runVercelCommand({
          vercelBin: options.vercelBin,
          cwd: workDir,
          args: [
            'deploy',
            '--prebuilt',
            '--yes',
            ...(options.mode === 'prod' ? ['--prod'] : []),
            ...vercelScopeArgs(scope),
            '--token',
            authTokenValue,
          ],
          env: {
            VERCEL_PROJECT_ID: projectId,
            VERCEL_ORG_ID: orgId,
            ...(teamId === undefined ? {} : { VERCEL_TEAM_ID: teamId }),
          },
        }),
      })

      if (deployResult.status !== 0) {
        return yield* failWithRecord(
          classifyVercelFailure({
            target: options.target,
            status: deployResult.status,
            stdout: deployResult.stdout,
            stderr: deployResult.stderr,
            authToken: authTokenValue,
            operation: 'deploy',
          }),
        )
      }

      const rawDeployUrl = extractDeployUrl(deployResult.stdout)
      if (rawDeployUrl === undefined) {
        const sanitizedStdout = redactDeployDiagnosticText(deployResult.stdout, {
          secretValues: [authTokenValue],
        }).trim()
        return yield* failWithRecord(
          new InvalidProviderOutput({
            provider: 'vercel',
            target: options.target,
            outputKind: 'url',
            message: 'Vercel CLI did not print a vercel.app deploy URL',
            diagnostics: sanitizedStdout.length === 0 ? undefined : { stdout: sanitizedStdout },
          }),
        )
      }

      let finalUrl = rawDeployUrl
      if (alias !== undefined) {
        const aliasHost = `${alias}.vercel.app`
        const aliasResult = yield* DeployProviderOperation.with({
          attributes: {
            provider: 'vercel',
            target: input.target,
          },
          effect: runVercelCommand({
            vercelBin: options.vercelBin,
            cwd: workDir,
            args: [
              'alias',
              rawDeployUrl,
              aliasHost,
              ...vercelScopeArgs(scope),
              '--token',
              authTokenValue,
            ],
            env: {
              VERCEL_PROJECT_ID: projectId,
              VERCEL_ORG_ID: orgId,
              ...(teamId === undefined ? {} : { VERCEL_TEAM_ID: teamId }),
            },
          }),
        })
        if (aliasResult.status !== 0) {
          return yield* failWithRecord(
            classifyVercelFailure({
              target: options.target,
              status: aliasResult.status,
              stdout: aliasResult.stdout,
              stderr: aliasResult.stderr,
              authToken: authTokenValue,
              operation: 'alias',
            }),
          )
        }
        finalUrl = `https://${aliasHost}`
      }

      const preliminary = decodeResultEither({
        _tag: 'DeployResult',
        schemaVersion: 1,
        provider: 'vercel',
        target: options.target,
        mode: options.mode,
        rawDeployUrl,
        finalUrl,
        alias,
        startedAtUtc: createdAtUtc,
        endedAtUtc: isoNow(),
        attempts: 1,
      })

      if (Either.isLeft(preliminary) === true) {
        return yield* failWithRecord(
          new InvalidProviderOutput({
            provider: 'vercel',
            target: options.target,
            outputKind: 'provider-response',
            message: 'Vercel deploy result did not match the ci-tools schema',
            diagnostics: { finalUrl },
          }),
        )
      }

      if (input.e2e?.verifyContent !== undefined) {
        yield* verifyFinalUrl({
          target: input.target,
          finalUrl: preliminary.right.finalUrl,
          path: input.e2e.verifyContent.path,
          expectedText: input.e2e.verifyContent.expectedText,
          protectionBypass,
        }).pipe(Effect.catchAll(failWithRecord))
      }

      const cleanup =
        input.e2e?.allowSharedProject === true
          ? yield* cleanupAlias({
              target: input.target,
              alias,
              allowSharedProject: true,
              workDir,
              vercelBin: options.vercelBin,
              authToken: authTokenValue,
              projectId,
              orgId,
              teamId,
              scope,
            })
          : undefined

      const decoded = decodeResultEither({
        _tag: 'DeployResult',
        schemaVersion: 1,
        provider: 'vercel',
        target: options.target,
        mode: options.mode,
        rawDeployUrl,
        finalUrl,
        alias,
        startedAtUtc: createdAtUtc,
        endedAtUtc: isoNow(),
        attempts: 1,
        ...(cleanup === undefined ? {} : { cleanup }),
      })
      if (Either.isLeft(decoded) === true) {
        return yield* failWithRecord(
          new InvalidProviderOutput({
            provider: 'vercel',
            target: options.target,
            outputKind: 'provider-response',
            message: 'Vercel cleanup result did not match the ci-tools schema',
            diagnostics: {
              finalUrl,
              cleanup:
                cleanup === undefined
                  ? 'undefined'
                  : `${cleanup.status}${cleanup.message === undefined ? '' : `:${cleanup.message}`}`,
              cause: String(decoded.left),
            },
          }),
        )
      }

      process.stdout.write(`Vercel deploy URL: ${finalUrl}\n`)
      yield* writeDevenvTaskOutput({
        result: decoded.right,
        taskOutputFile: process.env.DEVENV_TASK_OUTPUT_FILE,
      })
      const recordJson = yield* emitWorkflowReportRecord({
        workflowReportOutputFile: options.workflowReportOutputFile,
        record: deploySuccessRecord({
          input,
          result: decoded.right,
          createdAtUtc,
        }),
      })
      yield* writeGithubDeployOutputs({
        result: decoded.right,
        recordJson,
        workflowReportOutputFile: options.workflowReportOutputFile,
        githubOutputFile: options.githubOutputFile,
        githubEnvFile: options.githubEnvFile,
        urlEnvKey: options.urlEnvKey,
      })
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  } finally {
    if (cleanupLocalVercel === true) {
      rmSync('.vercel', { recursive: true, force: true })
    }
  }
})
