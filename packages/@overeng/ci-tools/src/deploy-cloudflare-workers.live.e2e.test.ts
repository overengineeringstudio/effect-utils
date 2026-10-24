import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect } from 'effect'
import { expect } from 'vitest'

import { runCloudflareWorkersDeploy } from './deploy-cloudflare-workers.ts'

// Requires an explicitly supplied disposable Worker configuration; never runs in normal CI.
const enabled = process.env.CI_TOOLS_CLOUDFLARE_WORKERS_LIVE === '1'
const liveIt = enabled === true ? it.effect : it.effect.skip

describe('Cloudflare Workers live deployment', () => {
  liveIt('uploads a preview version to a disposable Worker without moving production traffic', () =>
    Effect.gen(function* () {
      const config = process.env.CI_TOOLS_CLOUDFLARE_WORKERS_CONFIG
      if (config === undefined)
        return yield* Effect.die(
          'Set CI_TOOLS_CLOUDFLARE_WORKERS_CONFIG to a disposable Worker config',
        )
      const result = yield* runCloudflareWorkersDeploy({
        target: 'ci-tools-e2e',
        config,
        cwd: process.env.CI_TOOLS_CLOUDFLARE_WORKERS_CWD ?? '.',
        mode: 'pr',
        pr: 999999,
        productionDomains: [],
        authTokenEnv: 'CLOUDFLARE_API_TOKEN',
        accountIdEnv: 'CLOUDFLARE_ACCOUNT_ID',
        wranglerBin: process.env.CI_TOOLS_LIVE_WRANGLER_BIN ?? 'wrangler',
      })
      expect(result.deployId).toBeDefined()
      expect(result.finalUrl.protocol).toBe('https:')
      expect(result.alias).toBe('pr-999999')
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
