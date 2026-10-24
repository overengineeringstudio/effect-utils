/* oxlint-disable overeng/jsdoc-require-exports, overeng/named-args -- Provider entrypoint and schemas follow the shared deploy boundary. */
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

import { Effect, FileSystem, Schema } from 'effect'

import {
  DeployInputV1,
  DeployResultV1,
  InvalidProviderOutput,
  MissingAuth,
  ProviderOperationFailed,
  deployFailureRecord,
  deploySuccessRecord,
} from './deploy-domain.ts'
import {
  emitWorkflowReportRecord,
  writeDevenvTaskOutput,
  writeGithubDeployOutputs,
} from './deploy-io.ts'

export type CloudflareWorkersDeployCommandOptions = {
  readonly target: string
  readonly config: string
  readonly cwd: string
  readonly mode: 'prod' | 'pr'
  readonly pr?: number | undefined
  readonly productionDomains: readonly string[]
  readonly authTokenEnv: string
  readonly accountIdEnv: string
  readonly wranglerBin: string
  readonly workflowReportOutputFile?: string | undefined
  readonly githubOutputFile?: string | undefined
  readonly githubEnvFile?: string | undefined
  readonly urlEnvKey?: string | undefined
}

const WranglerDeployOutput = Schema.Struct({
  type: Schema.Literal('deploy'),
  version: Schema.Literal(1),
  version_id: Schema.String.check(Schema.isUUID()),
  targets: Schema.Array(Schema.String),
})
const WranglerUploadOutput = Schema.Struct({
  type: Schema.Literal('version-upload'),
  version: Schema.Literal(1),
  version_id: Schema.String.check(Schema.isUUID()),
  preview_url: Schema.String,
  preview_alias_url: Schema.String,
})
const WranglerOutput = Schema.Union([WranglerDeployOutput, WranglerUploadOutput])
const JsonLine = Schema.fromJsonString(Schema.Unknown)

/** Deploy an explicitly configured Worker, retaining credentials only in the subprocess environment. */
export const runCloudflareWorkersDeploy = Effect.fn('ci-tools.deploy.cloudflare-workers')(
  function* (options: CloudflareWorkersDeployCommandOptions) {
    const startedAtUtc = new Date().toISOString()
    const input = yield* Schema.decodeUnknownEffect(DeployInputV1)({
      _tag: 'DeployInput',
      schemaVersion: 1,
      provider: 'cloudflare-workers',
      target: options.target,
      mode: options.mode,
      artifactDir: options.cwd,
      pr: options.pr,
      alias: options.mode === 'pr' && options.pr !== undefined ? `pr-${options.pr}` : undefined,
      productionDomains: options.mode === 'prod' ? options.productionDomains : [],
      providerConfig: {
        _tag: 'CloudflareWorkersProviderConfig',
        config: options.config,
        accountIdEnv: options.accountIdEnv,
        authTokenEnv: options.authTokenEnv,
      },
    })
    const failure = (message: string) =>
      new ProviderOperationFailed({
        provider: 'cloudflare-workers',
        target: options.target,
        operation: 'deploy',
        transient: false,
        message,
      })
    const invalid = () =>
      new InvalidProviderOutput({
        provider: 'cloudflare-workers',
        target: options.target,
        outputKind: 'provider-response',
        message: 'Wrangler did not emit a valid deployment/version record with an HTTPS URL',
      })
    const deploy = Effect.gen(function* () {
      if (options.mode === 'pr' && options.pr === undefined)
        return yield* failure('Workers PR deploy requires --pr')
      const token = process.env[options.authTokenEnv]
      const accountId = process.env[options.accountIdEnv]
      for (const [envVar, value] of [
        [options.authTokenEnv, token],
        [options.accountIdEnv, accountId],
      ] as const) {
        if (value === undefined || value.trim() === '')
          return yield* new MissingAuth({
            provider: 'cloudflare-workers',
            target: options.target,
            envVar,
            message: 'Cloudflare credential environment variable is missing',
          })
      }
      const fs = yield* FileSystem.FileSystem
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: 'ci-tools-wrangler-' })
      const outputFile = join(temp, 'output.jsonl')
      const command = yield* Effect.try({
        try: () =>
          spawnSync(
            options.wranglerBin,
            [
              ...(options.mode === 'prod'
                ? ['deploy']
                : ['versions', 'upload', '--preview-alias', `pr-${options.pr}`]),
              '--config',
              resolve(options.cwd, options.config),
            ],
            {
              cwd: options.cwd,
              env: {
                ...process.env,
                CLOUDFLARE_API_TOKEN: token,
                CLOUDFLARE_ACCOUNT_ID: accountId,
                WRANGLER_OUTPUT_FILE_PATH: outputFile,
                WRANGLER_SEND_METRICS: 'false',
                CI: 'true',
              },
              encoding: 'utf8',
              maxBuffer: 64 * 1024 * 1024,
            },
          ),
        catch: () => failure('Could not execute Wrangler'),
      })
      // Wrangler can print arbitrary build output. Never forward it or retain diagnostics containing credentials.
      if (command.status !== 0 || command.error !== undefined)
        return yield* failure(
          'Wrangler deploy failed; inspect the configuration and credential permissions',
        )
      const text = yield* fs.readFileString(outputFile).pipe(Effect.mapError(invalid))
      const records = yield* Effect.forEach(
        text.split('\n').filter((line) => line.trim() !== ''),
        (line) => Schema.decodeUnknownEffect(JsonLine)(line).pipe(Effect.mapError(invalid)),
      )
      const matching = records.filter(
        (record) =>
          typeof record === 'object' &&
          record !== null &&
          'type' in record &&
          record.type === (options.mode === 'prod' ? 'deploy' : 'version-upload'),
      )
      if (matching.length !== 1) return yield* invalid()
      const output = yield* Schema.decodeUnknownEffect(WranglerOutput)(matching[0]).pipe(
        Effect.mapError(invalid),
      )
      // Wrangler renders custom domains as "host (custom domain ...)" in targets.
      // Other targets can be schedules/queue consumers; they are not deployment URLs.
      const urls =
        output.type === 'deploy'
          ? output.targets.flatMap((target) => {
              const host = target.split(' ')[0] ?? ''
              if (target.startsWith('https://') === true) return [host]
              if (
                target.includes(' (custom domain') === true &&
                /^[a-z0-9.-]+$/u.test(host) === true
              )
                return [`https://${host}`]
              return []
            })
          : [output.preview_alias_url]
      const finalUrl =
        options.mode === 'prod' && options.productionDomains.length > 0
          ? `https://${options.productionDomains[0]}`
          : urls[0]
      // Custom domains are configured by Wrangler, not inferred from input or assigned separately.
      if (
        options.mode === 'prod' &&
        options.productionDomains.some((domain) => urls.includes(`https://${domain}`) === false) ===
          true
      ) {
        return yield* failure(
          'Wrangler deployment did not report every configured production domain',
        )
      }
      return yield* Schema.decodeUnknownEffect(DeployResultV1)({
        _tag: 'DeployResult',
        schemaVersion: 1,
        provider: 'cloudflare-workers',
        target: options.target,
        mode: options.mode,
        deployId: output.version_id,
        rawDeployUrl: output.type === 'version-upload' ? output.preview_url : urls[0],
        finalUrl,
        alias: input.alias,
        productionDomains: input.productionDomains,
        startedAtUtc,
        endedAtUtc: new Date().toISOString(),
        attempts: 1,
      }).pipe(Effect.mapError(invalid))
    }).pipe(
      Effect.scoped,
      Effect.mapError((error) =>
        error instanceof MissingAuth ||
        error instanceof ProviderOperationFailed ||
        error instanceof InvalidProviderOutput
          ? error
          : failure('Could not read or prepare Wrangler deployment output'),
      ),
    )
    const result = yield* deploy.pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* emitWorkflowReportRecord({
            workflowReportOutputFile: options.workflowReportOutputFile,
            record: deployFailureRecord({
              input,
              failure: error,
              attempts: 1,
              createdAtUtc: startedAtUtc,
            }),
          })
          return yield* error
        }),
      ),
    )
    process.stdout.write(`Cloudflare Workers version: ${result.deployId}\n`)
    for (const domain of result.productionDomains ?? [])
      process.stdout.write(`Production URL: https://${domain}\n`)
    process.stdout.write(`Cloudflare Workers deploy URL: ${result.finalUrl}\n`)
    yield* writeDevenvTaskOutput({ result, taskOutputFile: process.env.DEVENV_TASK_OUTPUT_FILE })
    const recordJson = yield* emitWorkflowReportRecord({
      workflowReportOutputFile: options.workflowReportOutputFile,
      record: deploySuccessRecord({ input, result, createdAtUtc: startedAtUtc }),
    })
    yield* writeGithubDeployOutputs({
      result,
      recordJson,
      workflowReportOutputFile: options.workflowReportOutputFile,
      githubOutputFile: options.githubOutputFile,
      githubEnvFile: options.githubEnvFile,
      urlEnvKey: options.urlEnvKey,
    })
    return result
  },
)
