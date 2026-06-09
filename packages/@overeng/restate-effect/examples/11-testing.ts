/**
 * The Docker-free testing harness (`@overeng/restate-effect/testing`).
 *
 * `RestateTestHarness.layer({ services, appLayer })` is ONE scoped `Layer` that,
 * on acquire, boots a native `restate-server` (no Docker) on ephemeral ports
 * against an isolated temp dir, serves your endpoint with `appLayer` threaded into
 * the served runtime, registers the deployment, and exposes:
 *
 * - `harness.ingress.*` — the typed ingress client, pre-bound to the spawned
 *   server (you never thread `RestateIngress`).
 * - `harness.stateOf(contract, key)` — a typed State proxy (`get` / `getAll` /
 *   `set` / `setAll`) keyed AND value-typed against the contract's `state` block,
 *   over the Admin API, to seed pre-conditions and assert post-conditions without
 *   going through a handler.
 *
 * Two determinism-hunting flags mirror the SDK test environment:
 *
 * - `alwaysReplay: true` — force a replay at every suspension (surfaces
 *   journal-shape divergence: the classic replay bug).
 * - `disableRetries: true` — surface failures immediately instead of retrying.
 *
 * `serverAvailable` lets a suite gracefully `skipIf` when no native binary is on
 * `$PATH` (outside the integration job). Consumers wire `@effect/vitest`'s
 * `it.layer` / `it.effect` themselves.
 *
 * As with the endpoint, one harness serves ONE endpoint and therefore ONE `AppR`
 * (see `04-endpoint.ts`). The Greeter (which needs `Greeting`) and the all-`never`
 * constructs are served by two harnesses below. This module exports the LAYERS the
 * example integration test builds on; the `it.effect` assertions live in
 * `src/examples.integration.test.ts`.
 */
import { Layer } from 'effect'

import { RestateTestHarness, serverAvailable } from '../src/testing/testing.ts'
import { Greeting, GreeterLive } from './01-service.ts'
import { CounterLive } from './02-virtual-object.ts'
import { ApprovalLive } from './03-workflow.ts'
import { WaiterLive } from './07-clients-idempotency-awakeables.ts'

export { serverAvailable }

/* Harness #1: the Greeter Service, with the application Layer it needs. */
export const GreeterHarness = RestateTestHarness.layer({
  services: [GreeterLive],
  appLayer: Greeting.Default,
  disableRetries: true, // surface failures immediately, sharpening assertions
})

/* Harness #2: the all-`never` constructs (an Object, a Workflow, an awakeable
 * Object). No application service, so `appLayer` is the empty Layer. */
export const StatefulHarness = RestateTestHarness.layer({
  services: [CounterLive, ApprovalLive, WaiterLive],
  appLayer: Layer.empty,
  disableRetries: true,
})

/* The Counter under `alwaysReplay`, to assert journaled handlers are
 * replay-stable (every suspension forces a replay). */
export const ReplayHarness = RestateTestHarness.layer({
  services: [CounterLive],
  appLayer: Layer.empty,
  alwaysReplay: true,
  disableRetries: true,
})
