import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, FileSystem, Result, Schema, Stream } from 'effect'
import * as HttpClient from 'effect/http/HttpClient'
import * as HttpClientResponse from 'effect/http/HttpClientResponse'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'
import type { Scope } from 'effect/Scope'
import { expect } from 'vitest'

import { verifyAndCleanupCloudflareWorkers } from './deploy-cloudflare-workers-live.ts'
import { DeployResultV1 } from './deploy-domain.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const cliPath = join(repoRoot, 'packages/@overeng/ci-tools/bin/ci-tools.ts')
const versionId = '11111111-1111-4111-8111-111111111111'
const token = 'workers-token-redaction-sentinel'
const account = 'fixture-account'
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
const json = <TSchema extends Schema.Top>(schema: TSchema) => Schema.fromJsonString(schema)
const encodeJson = Schema.encodeSync(json(Schema.Unknown))
const encodeArgs = Schema.encodeSync(json(Schema.Array(Schema.String)))
const reportSchema = json(
  Schema.Struct({ status: Schema.String, data: Schema.Record(Schema.String, Schema.Unknown) }),
)
const tasksSchema = json(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      exec: Schema.NullOr(Schema.String),
      after: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
)

const runProcess = Effect.fn('test.workers.run-process')(function* (opts: {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
}) {
  const spawner = yield* ChildProcessSpawner
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  )
  const child = yield* spawner.spawn(
    ChildProcess.make(opts.command, opts.args, {
      cwd: opts.cwd,
      env: { ...inheritedEnv, ...opts.env },
    }),
  )
  const [stdout, stderr, status] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(child.stdout)),
      Stream.mkString(Stream.decodeText(child.stderr)),
      child.exitCode,
    ],
    { concurrency: 3 },
  )
  return { stdout, stderr, status }
})

// Like shared/tests/deploy-task-e2e.test.sh, evaluate the actual on-disk module,
// then launch its exec scripts. Dependencies come from the evaluated `after`
// graph, not a copy of the module's deploy command or a direct adapter call.
const fixture = Effect.fn('test.workers.task-fixture')(function* (
  opts: {
    readonly apiStatus?: number
    readonly wranglerMode?: string
    readonly cleanupStatus?: number
  } = {},
) {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'ci-tools-workers-task-' })
  const app = join(root, 'consumer app')
  const bin = join(root, 'bin')
  yield* fs.makeDirectory(app)
  yield* fs.makeDirectory(bin)
  const requests: {
    method: string | undefined
    url: string | undefined
    auth: string | undefined
  }[] = []
  const server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, auth: request.headers.authorization })
    const status =
      request.url === `/accounts/${account}/workers/scripts/fixture-worker/settings`
        ? (opts.apiStatus ?? 200)
        : request.method === 'DELETE' &&
            request.url ===
              `/accounts/${account}/workers/workers/fixture-worker/versions/${versionId}`
          ? (opts.cleanupStatus ?? 200)
          : 404
    response.writeHead(status, { 'content-type': 'application/json', connection: 'close' })
    response.end(
      encodeJson(
        status === 200
          ? { success: true, result: {} }
          : { success: false, errors: [{ code: status, message: token }] },
      ),
    )
  })
  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((done) => server.listen(0, '127.0.0.1', done))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((done, reject) =>
            server.close((error) => (error === undefined ? done() : reject(error))),
          ),
      ),
  )
  const address = server.address()
  if (address === null || typeof address === 'string')
    return yield* Effect.die('Expected TCP server')
  const apiBaseUrl = `http://127.0.0.1:${address.port}`
  const log = join(root, 'sequence.log')
  const wranglerLog = join(root, 'wrangler.json')
  const cliLog = join(root, 'cli-args.json')
  const cli = join(bin, 'ci-tools')
  const wrangler = join(bin, 'wrangler')
  const writeExecutable = Effect.fn('test.workers.write-executable')(function* (
    path: string,
    text: string,
  ) {
    yield* fs.writeFileString(path, text)
    yield* fs.chmod(path, 0o700)
  })
  yield* writeExecutable(
    join(bin, 'jq'),
    `#!/usr/bin/env bash\nexec ${shellQuote(process.env.JQ_BIN ?? 'jq')} "$@"\n`,
  )
  yield* writeExecutable(
    cli,
    `#!/usr/bin/env bun
await Bun.write(${encodeJson(cliLog)}, JSON.stringify(process.argv.slice(2)))
import { appendFileSync } from 'node:fs'
appendFileSync(${encodeJson(log)}, 'cli\\n')
const child = Bun.spawn(['bun', ${encodeJson(cliPath)}, ...process.argv.slice(2), ...(process.env.TEST_EXTRA_ARGS ? JSON.parse(process.env.TEST_EXTRA_ARGS) : [])], {stdin:'inherit', stdout:'inherit', stderr:'inherit', env:process.env})
process.exit(await child.exited)
`,
  )
  yield* writeExecutable(
    wrangler,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs'
appendFileSync(${encodeJson(log)}, 'wrangler\\n')
const args = process.argv.slice(2)
await Bun.write(${encodeJson(wranglerLog)}, JSON.stringify({args, cwd:process.cwd(), token:process.env.CLOUDFLARE_API_TOKEN, account:process.env.CLOUDFLARE_ACCOUNT_ID, consumer:process.env.CONSUMER_BUILD_VALUE, override:process.env.DEPLOY_OVERRIDE, built:await Bun.file('built.txt').text()}))
if (process.env.FAKE_WRANGLER_MODE === 'failure') {
  console.log(process.env.CLOUDFLARE_API_TOKEN)
  console.error(process.env.CLOUDFLARE_API_TOKEN)
  process.exit(9)
}
const record = args[0] === 'deploy'
  ? {type:'deploy', version:1, version_id:'${versionId}', targets:['example.com (custom domain)', 'schedule: * * * * *']}
  : {type:'version-upload', version:1, version_id:'${versionId}', preview_url:'https://11111111-demo.test.workers.dev', preview_alias_url:'https://pr-7-demo.test.workers.dev'}
if (process.env.FAKE_WRANGLER_MODE === 'invalid-url') record.preview_url = 'http://insecure.example.test'
const output = process.env.FAKE_WRANGLER_MODE === 'invalid-json' ? '{invalid ' + process.env.CLOUDFLARE_API_TOKEN : process.env.FAKE_WRANGLER_MODE === 'invalid-record' ? JSON.stringify({type:record.type, version:1, version_id:process.env.CLOUDFLARE_API_TOKEN}) : JSON.stringify(record)
await Bun.write(process.env.WRANGLER_OUTPUT_FILE_PATH, output + '\\n')
`,
  )
  yield* fs.writeFileString(
    join(app, 'wrangler.jsonc'),
    '{"name":"fixture-worker","main":"worker.js","compatibility_date":"2026-01-01"}',
  )
  yield* fs.writeFileString(
    join(app, 'worker.js'),
    'export default { fetch() { return new Response("fixture") } }',
  )
  const build = `set -euo pipefail\nprintf 'build\\n' >> ${shellQuote(log)}\nif [ "\${FAIL_BUILD:-}" = yes ]; then exit 23; fi\nprintf '%s' "$CONSUMER_BUILD_VALUE" > ${shellQuote(join(app, 'built.txt'))}`
  const nixString = (value: string) =>
    `(builtins.fromJSON ${encodeJson(encodeJson(value)).replaceAll('${', '\\${')})`
  const expression = `let
      flake = builtins.getFlake ${nixString(process.env.NIX_FLAKE_REF ?? `git+file://${repoRoot}?shallow=1`)};
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evaluated = pkgs.lib.evalModules {
        specialArgs = { pkgs = pkgs // { jq = ${nixString(root)}; }; };
        modules = [
          ({ lib, ... }: {
            options.tasks = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = {}; };
            options.processes = lib.mkOption { type = lib.types.attrsOf lib.types.anything; default = {}; };
            options.packages = lib.mkOption { type = lib.types.listOf lib.types.anything; default = []; };
            config.tasks."consumer:build" = { exec = ${nixString(build)}; after = []; };
          })
          (import ${repoRoot}/nix/devenv-modules/tasks/shared/cloudflare-workers.nix {
            ciToolsBin = ${nixString(cli)};
            wranglerBin = ${nixString(wrangler)};
            cloudflareApiBaseUrl = ${nixString(apiBaseUrl)};
            authTokenEnv = "TEST_CF_TOKEN";
            accountIdEnv = "TEST_CF_ACCOUNT";
            deployments = [{ name = "demo"; workerName = "fixture-worker"; config = "wrangler.jsonc";
              cwd = ${nixString(app)}; productionDomains = [ "example.com" ];
              afterTask = "consumer:build"; env.DEPLOY_OVERRIDE = "deploy-only";
            }];
          })
        ];
      };
    in builtins.mapAttrs (_: task: { exec = task.exec or null; after = task.after or []; }) evaluated.config.tasks`
  const evaluated = yield* runProcess({
    command: process.env.NIX_INSTANTIATE_BIN ?? 'nix-instantiate',
    args: ['--eval', '--read-write-mode', '--strict', '--json', '--expr', expression],
    cwd: root,
  })
  expect(evaluated.status, evaluated.stderr).toBe(0)
  const tasks = yield* Schema.decodeEffect(tasksSchema)(evaluated.stdout)
  expect(tasks['cloudflare-workers:deploy:demo']?.after).toEqual(['consumer:build'])
  const scripts: string[] = []
  const orderedTasks: string[] = []
  const visited = new Set<string>()
  const visit = (name: string): void => {
    if (visited.has(name) === true) return
    visited.add(name)
    for (const dependency of tasks[name]?.after ?? []) visit(dependency)
    orderedTasks.push(name)
  }
  visit('cloudflare-workers:deploy')
  for (const name of orderedTasks) {
    const task = tasks[name]
    if (task === undefined) return yield* Effect.die(`Missing task ${name}`)
    if (task.exec !== null) {
      const path = join(root, `task-${scripts.length}.sh`)
      yield* fs.writeFileString(path, task.exec)
      scripts.push(path)
    }
  }
  const launcher = join(root, 'launch.sh')
  yield* fs.writeFileString(
    launcher,
    `set -euo pipefail\n${scripts.map((path) => `bash ${shellQuote(path)}`).join('\n')}\n`,
  )
  const report = join(root, 'report.jsonl')
  const taskOutput = join(root, 'task-output')
  const githubOutput = join(root, 'github-output')
  const githubEnv = join(root, 'github-env')
  const run = (
    input: { readonly type: 'prod' | 'pr'; readonly pr?: number },
    overrides: Readonly<Record<string, string>> = {},
  ) =>
    runProcess({
      command: 'bash',
      args: [launcher],
      cwd: root,
      env: {
        TEST_CF_TOKEN: token,
        TEST_CF_ACCOUNT: account,
        CLOUDFLARE_API_TOKEN: '',
        CLOUDFLARE_ACCOUNT_ID: '',
        CONSUMER_BUILD_VALUE: 'consumer-secret-passthrough',
        DEPLOY_OVERRIDE: 'inherited',
        FAKE_WRANGLER_MODE: opts.wranglerMode ?? 'ok',
        DEVENV_TASK_INPUT: encodeJson(input),
        DEVENV_TASK_OUTPUT_FILE: taskOutput,
        WORKFLOW_REPORT_OUTPUT_FILE: report,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_ENV: githubEnv,
        FORCE_COLOR: '0',
        OTEL_EXPORTER_OTLP_ENDPOINT: '',
        OTELITE_HTTP_ENDPOINT: '',
        ...overrides,
      },
    })
  const readReport = Effect.gen(function* () {
    const text = yield* fs.readFileString(report)
    const lines = text.split('\n').filter((line) => line.startsWith('WORKFLOW_REPORT_V1: '))
    expect(lines).toHaveLength(1)
    return yield* Schema.decodeEffect(reportSchema)(lines[0]!.slice('WORKFLOW_REPORT_V1: '.length))
  })
  return {
    fs,
    root,
    app,
    run,
    readReport,
    requests,
    log,
    wranglerLog,
    cliLog,
    report,
    taskOutput,
    githubOutput,
    githubEnv,
  }
})

const withRuntime = <TValue, TError>(
  effect: Effect.Effect<TValue, TError, FileSystem.FileSystem | ChildProcessSpawner | Scope>,
) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer))

describe('Cloudflare Workers Nix task launcher + real CLI', () => {
  for (const mode of ['prod', 'pr'] as const) {
    it.effect(
      `runs the consumer build before ${mode} deployment and publishes outputs`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture()
          const result = yield* f.run({ type: mode, ...(mode === 'pr' ? { pr: 7 } : {}) })
          expect(result.status, result.stderr).toBe(0)
          expect(yield* f.fs.readFileString(f.log)).toBe('build\ncli\nwrangler\n')
          expect(f.requests).toEqual([
            {
              method: 'GET',
              url: `/accounts/${account}/workers/scripts/fixture-worker/settings`,
              auth: `Bearer ${token}`,
            },
          ])
          const invocation = yield* Schema.decodeEffect(
            json(
              Schema.Struct({
                args: Schema.Array(Schema.String),
                cwd: Schema.String,
                token: Schema.String,
                account: Schema.String,
                consumer: Schema.String,
                override: Schema.String,
                built: Schema.String,
              }),
            ),
          )(yield* f.fs.readFileString(f.wranglerLog))
          expect(invocation).toMatchObject({
            cwd: f.app,
            token,
            account,
            consumer: 'consumer-secret-passthrough',
            override: 'deploy-only',
            built: 'consumer-secret-passthrough',
          })
          expect(invocation.args).toEqual([
            ...(mode === 'prod' ? ['deploy'] : ['versions', 'upload', '--preview-alias', 'pr-7']),
            '--config',
            join(f.app, 'wrangler.jsonc'),
            '--name',
            'fixture-worker',
          ])
          const cliArgs = yield* f.fs.readFileString(f.cliLog)
          expect(cliArgs).toContain('--worker-name')
          expect(cliArgs).toContain('fixture-worker')
          expect(cliArgs).not.toContain(token)
          expect(invocation.args).not.toContain(token)
          const finalUrl =
            mode === 'prod' ? 'https://example.com/' : 'https://pr-7-demo.test.workers.dev/'
          const record = yield* f.readReport
          expect(record.status).toBe('success')
          expect(record.data).toMatchObject({
            provider: 'cloudflare-workers',
            target: 'demo',
            mode,
            deployId: versionId,
            finalUrl,
          })
          expect(yield* f.fs.readFileString(f.taskOutput)).toContain(`"DEPLOY_ID":"${versionId}"`)
          expect(yield* f.fs.readFileString(f.githubOutput)).toContain(`final_url=${finalUrl}`)
          expect(yield* f.fs.readFileString(f.githubOutput)).toContain('workflow_report=')
          expect(yield* f.fs.readFileString(f.githubEnv)).toContain(
            `CLOUDFLARE_WORKERS_DEPLOY_URL_DEMO=${finalUrl}`,
          )
          expect(
            `${result.stdout}${result.stderr}${yield* f.fs.readFileString(f.report)}`,
          ).not.toContain(token)
        }).pipe(withRuntime),
      120_000,
    )
  }

  it.effect(
    'does not invoke the CLI or provider when the consumer build fails',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const result = yield* f.run({ type: 'prod' }, { FAIL_BUILD: 'yes' })
        expect(result.status).toBe(23)
        expect(yield* f.fs.readFileString(f.log)).toBe('build\n')
        expect(f.requests).toEqual([])
        expect(yield* f.fs.exists(f.cliLog)).toBe(false)
        expect(yield* f.fs.exists(f.wranglerLog)).toBe(false)
      }).pipe(withRuntime),
    120_000,
  )

  for (const [status, errorKind] of [
    [401, 'Unauthorized'],
    [404, 'ProviderProjectLookupFailed'],
    [503, 'ProviderProjectLookupFailed'],
  ] as const) {
    it.effect(
      `records typed ${status} lookup failure before invoking Wrangler`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture({ apiStatus: status })
          const result = yield* f.run({ type: 'prod' })
          expect(result.status).not.toBe(0)
          expect(f.requests).toHaveLength(1)
          expect(yield* f.fs.exists(f.wranglerLog)).toBe(false)
          expect(yield* f.fs.readFileString(f.log)).toBe('build\ncli\n')
          expect(yield* f.readReport).toMatchObject({
            status: 'failure',
            data: { errorKind, retryable: status === 503 },
          })
          expect(
            `${result.stdout}${result.stderr}${yield* f.fs.readFileString(f.report)}`,
          ).not.toContain(token)
          expect(yield* f.fs.exists(f.githubEnv)).toBe(false)
        }).pipe(withRuntime),
      120_000,
    )
  }

  for (const mode of ['invalid-json', 'invalid-record', 'failure'] as const) {
    it.effect(
      `redacts credentials from ${mode} Wrangler failure and its report`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture({ wranglerMode: mode })
          const result = yield* f.run({ type: 'pr', pr: 7 })
          expect(result.status).not.toBe(0)
          expect(yield* f.fs.exists(f.wranglerLog)).toBe(true)
          expect(yield* f.readReport).toMatchObject({
            status: 'failure',
            data: {
              errorKind: mode === 'failure' ? 'ProviderOperationFailed' : 'InvalidProviderOutput',
            },
          })
          expect(
            `${result.stdout}${result.stderr}${yield* f.fs.readFileString(f.report)}`,
          ).not.toContain(token)
          expect(yield* f.fs.exists(f.githubEnv)).toBe(false)
        }).pipe(withRuntime),
      120_000,
    )
  }

  it.effect(
    'rejects an unsafe shared-project alias before lookup or upload',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const result = yield* f.run(
          { type: 'pr', pr: 7 },
          {
            TEST_EXTRA_ARGS: encodeArgs([
              '--preview-alias',
              'pr-7',
              '--e2e-allow-shared-project',
              '--e2e-reserved-alias-prefix',
              'ci-tools-e2e',
              '--e2e-verify-path',
              '/marker',
              '--e2e-verify-text',
              'fixture-marker',
            ]),
          },
        )
        expect(result.status).not.toBe(0)
        expect(f.requests).toEqual([])
        expect(yield* f.fs.exists(f.wranglerLog)).toBe(false)
        expect(yield* f.readReport).toMatchObject({
          status: 'failure',
          data: { errorKind: 'UnsafeE2EAlias' },
        })
        expect(
          `${result.stdout}${result.stderr}${yield* f.fs.readFileString(f.report)}`,
        ).not.toContain(token)
      }).pipe(withRuntime),
    120_000,
  )

  for (const cleanupStatus of [200, 503]) {
    it.effect(
      `cleans uploaded version after invalid preview URL when cleanup returns ${cleanupStatus}`,
      () =>
        Effect.gen(function* () {
          const f = yield* fixture({ wranglerMode: 'invalid-url', cleanupStatus })
          const result = yield* f.run(
            { type: 'pr', pr: 7 },
            {
              TEST_EXTRA_ARGS: encodeArgs([
                '--preview-alias',
                'ci-tools-e2e-7',
                '--e2e-allow-shared-project',
                '--e2e-reserved-alias-prefix',
                'ci-tools-e2e',
                '--e2e-verify-path',
                '/marker',
                '--e2e-verify-text',
                'fixture-marker',
              ]),
            },
          )
          expect(result.status).not.toBe(0)
          expect(yield* f.fs.exists(f.wranglerLog)).toBe(true)
          expect(f.requests.map(({ method, url }) => ({ method, url }))).toEqual([
            { method: 'GET', url: `/accounts/${account}/workers/scripts/fixture-worker/settings` },
            {
              method: 'DELETE',
              url: `/accounts/${account}/workers/workers/fixture-worker/versions/${versionId}`,
            },
          ])
          expect(yield* f.readReport).toMatchObject({
            status: 'failure',
            data: {
              errorKind: 'InvalidProviderOutput',
              diagnostics: {
                cleanupStatus: cleanupStatus === 200 ? 'succeeded' : 'failed',
              },
            },
          })
          expect(
            `${result.stdout}${result.stderr}${yield* f.fs.readFileString(f.report)}`,
          ).not.toContain(token)
        }).pipe(withRuntime),
      120_000,
    )
  }

  it.effect(
    'records missing consumer credentials without reaching the provider',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const result = yield* f.run({ type: 'prod' }, { TEST_CF_TOKEN: '' })
        expect(result.status).not.toBe(0)
        expect(f.requests).toEqual([])
        expect(yield* f.fs.exists(f.wranglerLog)).toBe(false)
        expect(yield* f.readReport).toMatchObject({
          status: 'failure',
          data: { errorKind: 'MissingAuth' },
        })
      }).pipe(withRuntime),
    120_000,
  )

  it.effect(
    'rejects missing PR task input before launching the CLI',
    () =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const result = yield* f.run({ type: 'pr' })
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain("PR deploy requires 'pr' input")
        expect(f.requests).toEqual([])
        expect(yield* f.fs.exists(f.cliLog)).toBe(false)
        expect(yield* f.fs.exists(f.wranglerLog)).toBe(false)
      }).pipe(withRuntime),
    120_000,
  )
})

// Keep HTTPS URLs at the real schema boundary. The Effect HttpClient test seam
// lets marker and cleanup responses be controlled without weakening TLS rules.
describe('Cloudflare Workers shared-project marker verification and cleanup', () => {
  for (const markerMatches of [true, false]) {
    for (const cleanupStatus of [200, 503]) {
      it.effect(
        `preserves marker ${markerMatches === true ? 'success' : 'mismatch'} when cleanup returns ${cleanupStatus}`,
        () =>
          Effect.gen(function* () {
            const requests: {
              readonly method: string
              readonly url: string
              readonly authorization: string | undefined
            }[] = []
            const client = HttpClient.make((request, url) =>
              Effect.sync(() => {
                requests.push({
                  method: request.method,
                  url: url.toString(),
                  authorization: request.headers['authorization'],
                })
                if (request.method === 'GET') {
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(
                      markerMatches === true ? 'served fixture-marker content' : 'wrong artifact',
                    ),
                  )
                }
                return HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    encodeJson(cleanupStatus === 200 ? { success: true } : { success: false }),
                    { status: cleanupStatus, headers: { 'content-type': 'application/json' } },
                  ),
                )
              }),
            )
            const deploy = yield* Schema.decodeEffect(DeployResultV1)({
              _tag: 'DeployResult',
              schemaVersion: 1,
              provider: 'cloudflare-workers',
              target: 'demo',
              mode: 'pr',
              deployId: versionId,
              rawDeployUrl: 'https://11111111-demo.test.workers.dev/',
              finalUrl: 'https://ci-tools-e2e-7-demo.test.workers.dev/',
              alias: 'ci-tools-e2e-7',
              productionDomains: [],
              startedAtUtc: '2026-10-25T08:00:00Z',
              endedAtUtc: '2026-10-25T08:01:00Z',
              attempts: 1,
            })
            const outcome = yield* verifyAndCleanupCloudflareWorkers({
              complete: Effect.succeed(deploy),
              versionId,
              workerName: 'fixture-worker',
              accountId: account,
              authToken: token,
              apiBaseUrl: 'https://api.cloudflare.test/client/v4',
              verifyPath: '/marker.txt',
              expectedText: 'fixture-marker',
            }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.result)
            const expectedCleanup = cleanupStatus === 200 ? 'succeeded' : 'failed'
            expect(requests).toEqual([
              {
                method: 'GET',
                url: 'https://ci-tools-e2e-7-demo.test.workers.dev/marker.txt',
                authorization: undefined,
              },
              {
                method: 'DELETE',
                url: `https://api.cloudflare.test/client/v4/accounts/${account}/workers/workers/fixture-worker/versions/${versionId}`,
                authorization: `Bearer ${token}`,
              },
            ])
            if (markerMatches === true) {
              expect(Result.isSuccess(outcome)).toBe(true)
              if (Result.isSuccess(outcome) === true) {
                expect(outcome.success.cleanup?.status).toBe(expectedCleanup)
                expect(outcome.success.deployId).toBe(versionId)
                expect(outcome.success.finalUrl).toEqual(deploy.finalUrl)
              }
            } else {
              expect(Result.isFailure(outcome)).toBe(true)
              if (Result.isFailure(outcome) === true) {
                expect(outcome.failure._tag).toBe('VerificationFailed')
                expect(outcome.failure.message).toContain('marker text')
                expect(outcome.failure.diagnostics).toMatchObject({
                  cleanupStatus: expectedCleanup,
                })
              }
            }
          }).pipe(withRuntime),
      )
    }
  }
})
