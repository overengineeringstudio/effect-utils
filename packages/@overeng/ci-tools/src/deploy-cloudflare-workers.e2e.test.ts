import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, FileSystem, Schema } from 'effect'
import { expect } from 'vitest'

import { runCloudflareWorkersDeploy } from './deploy-cloudflare-workers.ts'

const versionId = '11111111-1111-4111-8111-111111111111'
const json = Schema.fromJsonString(Schema.Unknown)

// The fake executable implements Wrangler's documented output file, not its human-readable logs.
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'ci-tools-workers-test-' })
  const bin = `${cwd}/wrangler`
  yield* fs.writeFileString(
    bin,
    `#!/usr/bin/env bun
const args = process.argv.slice(2)
await Bun.write(${JSON.stringify(`${cwd}/args.json`)}, JSON.stringify(args))
if (process.env.TEST_FAILURE === 'yes') {
  console.error(process.env.TEST_CF_TOKEN)
  process.exit(1)
}
const record = args[0] === 'deploy'
  ? {type:'deploy', version:1, version_id:'${versionId}', targets:['example.com (custom domain)', 'schedule: * * * * *']}
  : {type:'version-upload', version:1, version_id:'${versionId}', preview_url:'https://11111111-demo.test.workers.dev', preview_alias_url:'https://pr-7-demo.test.workers.dev'}
await Bun.write(process.env.WRANGLER_OUTPUT_FILE_PATH, process.env.TEST_INVALID === 'yes' ? '{}' : JSON.stringify(record) + '\\n')
`,
  )
  yield* fs.chmod(bin, 0o700)
  return { fs, cwd, bin }
})

// Credential names resolve at the edge; these literals are non-secret fixture values.
const env = { TEST_CF_TOKEN: 'fixture-token-value', TEST_CF_ACCOUNT: 'fixture-account' }

describe('Cloudflare Workers deployment', () => {
  it.effect('deploys production and emits typed report/task/GitHub outputs', () =>
    Effect.gen(function* () {
      const { fs, cwd, bin } = yield* fixture
      const task = `${cwd}/task.jsonl`
      Object.assign(process.env, env, { DEVENV_TASK_OUTPUT_FILE: task })
      try {
        const result = yield* runCloudflareWorkersDeploy({
          target: 'demo',
          cwd,
          config: 'wrangler.jsonc',
          mode: 'prod',
          productionDomains: ['example.com'],
          authTokenEnv: 'TEST_CF_TOKEN',
          accountIdEnv: 'TEST_CF_ACCOUNT',
          wranglerBin: bin,
          workflowReportOutputFile: `${cwd}/report`,
          githubOutputFile: `${cwd}/github`,
        })
        expect(result.deployId).toBe(versionId)
        expect(result.finalUrl.toString()).toBe('https://example.com/')
        expect(yield* fs.readFileString(`${cwd}/args.json`)).toContain('deploy')
        const report = yield* fs.readFileString(`${cwd}/report`)
        expect(report).toContain('WORKFLOW_REPORT_V1: ')
        expect(report).toContain(versionId)
        expect(report).not.toContain(env.TEST_CF_TOKEN)
        expect(yield* fs.readFileString(task)).toContain('DEPLOY_ID')
        expect(yield* fs.readFileString(`${cwd}/github`)).toContain('final_url=')
      } finally {
        delete process.env.DEVENV_TASK_OUTPUT_FILE
        delete process.env.TEST_CF_TOKEN
        delete process.env.TEST_CF_ACCOUNT
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  it.effect('uploads a PR alias without deploying or moving traffic', () =>
    Effect.gen(function* () {
      const { fs, cwd, bin } = yield* fixture
      Object.assign(process.env, env)
      try {
        const result = yield* runCloudflareWorkersDeploy({
          target: 'demo',
          cwd,
          config: 'wrangler.toml',
          mode: 'pr',
          pr: 7,
          productionDomains: ['example.com'],
          authTokenEnv: 'TEST_CF_TOKEN',
          accountIdEnv: 'TEST_CF_ACCOUNT',
          wranglerBin: bin,
        })
        const args = yield* Schema.decodeUnknownEffect(json)(
          yield* fs.readFileString(`${cwd}/args.json`),
        )
        expect(args).toEqual([
          'versions',
          'upload',
          '--preview-alias',
          'pr-7',
          '--config',
          `${cwd}/wrangler.toml`,
        ])
        expect(result.finalUrl.hostname).toBe('pr-7-demo.test.workers.dev')
        expect(result.productionDomains).toEqual([])
      } finally {
        delete process.env.TEST_CF_TOKEN
        delete process.env.TEST_CF_ACCOUNT
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  )

  for (const scenario of [
    'missing-auth',
    'invalid-output',
    'provider-failure',
    'missing-pr',
  ] as const) {
    it.effect(`reports ${scenario} without credential leakage`, () =>
      Effect.gen(function* () {
        const { fs, cwd, bin } = yield* fixture
        Object.assign(process.env, env)
        if (scenario === 'missing-auth') delete process.env.TEST_CF_TOKEN
        if (scenario === 'invalid-output') process.env.TEST_INVALID = 'yes'
        if (scenario === 'provider-failure') process.env.TEST_FAILURE = 'yes'
        try {
          const result = yield* runCloudflareWorkersDeploy({
            target: 'demo',
            cwd,
            config: 'wrangler.toml',
            mode: scenario === 'missing-pr' ? 'pr' : 'prod',
            productionDomains: [],
            authTokenEnv: 'TEST_CF_TOKEN',
            accountIdEnv: 'TEST_CF_ACCOUNT',
            wranglerBin: bin,
            workflowReportOutputFile: `${cwd}/report`,
          }).pipe(Effect.result)
          expect(result._tag).toBe('Failure')
          const report = yield* fs.readFileString(`${cwd}/report`)
          expect(report).toContain('"status":"failure"')
          expect(report).not.toContain(env.TEST_CF_TOKEN)
        } finally {
          delete process.env.TEST_CF_TOKEN
          delete process.env.TEST_CF_ACCOUNT
          delete process.env.TEST_INVALID
          delete process.env.TEST_FAILURE
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    )
  }
})
