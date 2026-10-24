import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, FileSystem, Layer, Schema } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'
import { expect } from 'vitest'

import { runCloudflareWorkersDeploy } from './deploy-cloudflare-workers.ts'

// Both switches are required: the live opt-in alone never grants shared-project access.
const enabled = process.env.CI_TOOLS_CLOUDFLARE_WORKERS_LIVE === '1'
const liveIt = enabled === true ? it.effect : it.effect.skip

describe('Cloudflare Workers live deployment', () => {
  liveIt(
    'verifies a local Worker marker in a reserved shared-project preview and records cleanup',
    () =>
      Effect.gen(function* () {
        if (process.env.CI_TOOLS_CLOUDFLARE_WORKERS_ALLOW_SHARED_PROJECT !== '1') {
          return yield* Effect.die(
            'Set CI_TOOLS_CLOUDFLARE_WORKERS_ALLOW_SHARED_PROJECT=1 to explicitly permit shared-project E2E',
          )
        }
        const workerName = process.env.CI_TOOLS_CLOUDFLARE_WORKERS_WORKER_NAME
        const reservedAliasPrefix = process.env.CI_TOOLS_CLOUDFLARE_WORKERS_RESERVED_ALIAS_PREFIX
        if (workerName === undefined || reservedAliasPrefix === undefined) {
          return yield* Effect.die(
            'Set CI_TOOLS_CLOUDFLARE_WORKERS_WORKER_NAME and CI_TOOLS_CLOUDFLARE_WORKERS_RESERVED_ALIAS_PREFIX',
          )
        }
        const fs = yield* FileSystem.FileSystem
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: 'ci-tools-workers-live-' })
        const runId = crypto.randomUUID()
        const marker = `ci-tools-live-workers-e2e:${runId}`
        const previewAlias = `${reservedAliasPrefix}-${runId.slice(0, 8)}`
        const json = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))
        const markerJson = yield* json(marker)
        yield* fs.writeFileString(
          `${cwd}/worker.js`,
          `export default { fetch() { return new Response(${markerJson}, { headers: { 'content-type': 'text/plain' } }) } }`,
        )
        yield* fs.writeFileString(
          `${cwd}/wrangler.json`,
          yield* json({
            name: workerName,
            main: 'worker.js',
            compatibility_date: '2026-01-01',
            workers_dev: true,
            preview_urls: true,
          }),
        )
        const reportFile = `${cwd}/report.jsonl`
        const result = yield* runCloudflareWorkersDeploy({
          target: 'ci-tools-e2e',
          workerName,
          config: 'wrangler.json',
          cwd,
          mode: 'pr',
          pr: 999999,
          previewAlias,
          productionDomains: [],
          authTokenEnv: 'CLOUDFLARE_API_TOKEN',
          accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
          cloudflareApiBaseUrl: 'https://api.cloudflare.com/client/v4',
          wranglerBin: process.env.CI_TOOLS_LIVE_WRANGLER_BIN ?? 'wrangler',
          workflowReportOutputFile: reportFile,
          e2eAllowSharedProject: true,
          e2eReservedAliasPrefix: reservedAliasPrefix,
          e2eVerifyPath: '/',
          e2eVerifyText: marker,
        })
        // Boolean assertions avoid printing private Worker/account URLs in failure output.
        expect(result.deployId !== undefined).toBe(true)
        expect(result.finalUrl.protocol === 'https:').toBe(true)
        expect(result.alias === previewAlias).toBe(true)
        expect(result.cleanup?.status === 'succeeded' || result.cleanup?.status === 'failed').toBe(
          true,
        )
        const report = yield* fs.readFileString(reportFile)
        expect(report.includes(`"cleanup":"${result.cleanup?.status}"`)).toBe(true)
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
      ),
    { timeout: 180_000 },
  )
})
