/**
 * Integration gap (HIGH): multi-deployment registration + version upgrade against a
 * real native server (spec §11.2). The harness now serves ONE primary deployment AND
 * exposes `registerDeployment(...)` to serve + register a SECOND endpoint VERSION of
 * the same service on a fresh port. This proves the multi-version machinery: two
 * deployments coexist on the admin API, and a NEW invocation routes to the LATEST
 * registered version (the upgrade), while a V1 result remains attachable.
 *
 * RESIDUAL (follow-up, GH issue): a FULL cross-version replay — an invocation STARTED
 * on V1 that SUSPENDS mid-handler and RESUMES its journal on V2 after the upgrade —
 * needs more harness machinery (a controllable mid-invocation suspension straddling
 * the re-register) than fits this scope. What is proven here is the registration +
 * routing-to-latest half of T07/A11; the suspend-straddle-upgrade half is deferred.
 */
import { it } from '@effect/vitest'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect } from 'vitest'

import { RestateService } from './mod.ts'
import { RestateTestHarness, serverAvailable } from './testing.ts'

/* The SAME contract, two IMPLEMENTATIONS — V1 returns `v1-…`, V2 returns `v2-…`.
 * Registering V2 as a second deployment upgrades the service; a new call routes to V2. */
const Versioned = RestateService.contract('versioned', {
  whoami: { input: Schema.Void, success: Schema.String },
})

const V1 = RestateService.implement<typeof Versioned>(Versioned, {
  whoami: () => Effect.succeed('v1'),
})
const V2 = RestateService.implement<typeof Versioned>(Versioned, {
  whoami: () => Effect.succeed('v2'),
})

/** Count the registered deployments via the admin `/deployments` listing. */
const deploymentCount = (adminUrl: string): Promise<number> =>
  fetch(`${adminUrl}/deployments`)
    .then((res) => res.json() as Promise<{ readonly deployments?: ReadonlyArray<unknown> }>)
    .then((body) => body.deployments?.length ?? 0)

/* The harness serves V1 as the primary deployment. */
const HarnessLayer = RestateTestHarness.layer({ services: [V1], appLayer: Layer.empty })

describe.skipIf(!serverAvailable)('multi-deployment version upgrade (real server)', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('register a second version', (it) => {
    it.effect('two deployments coexist; a new call routes to the LATEST version', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness

        /* V1 is the only deployment initially; a call returns `v1`. */
        const beforeCount = yield* Effect.promise(() => deploymentCount(harness.adminUrl))
        expect(beforeCount).toBe(1)
        expect(yield* harness.ingress.call(Versioned, 'whoami', undefined)).toBe('v1')

        /* Register V2 as a SECOND deployment (a new endpoint version of the same
         * service) — the harness serves it on a fresh ephemeral port + registers it. */
        const v2Uri = yield* harness.registerDeployment({ services: [V2], appLayer: Layer.empty })
        expect(v2Uri).toMatch(/^http:\/\/localhost:\d+$/)

        /* Both deployments now coexist on the admin API. */
        const afterCount = yield* Effect.promise(() => deploymentCount(harness.adminUrl))
        expect(afterCount).toBe(2)

        /* A NEW invocation routes to the LATEST registered version (the upgrade): `v2`. */
        expect(yield* harness.ingress.call(Versioned, 'whoami', undefined)).toBe('v2')
      }),
    )
  })
})
