/**
 * The endpoint: serving one or more implementations over an HTTP/2 (h2c) server
 * the `restate-server` discovers and invokes.
 *
 * The endpoint is a scoped `Layer`. It captures the application runtime ONCE,
 * materializes each implementation against it, starts the h2c server on acquire,
 * and closes it on scope teardown — so it participates in graceful shutdown.
 *
 * Two surfaces:
 *
 * - `layer(opts)` — the scoped `Layer<never, RestateError, AppR>`. Compose it
 *   like any Layer; provide the application Layer (`AppR`) to discharge handler
 *   requirements.
 * - `serve(opts)` — `Layer.launch(layer(opts))`: a long-lived `Effect` that
 *   blocks until interrupted, running finalizers (server close + every scoped
 *   application resource) on SIGTERM. This is the production entrypoint.
 *
 * In production you wrap `serve` with `@effect/platform-node`'s
 * `NodeRuntime.runMain` (which maps SIGTERM → fiber interruption → finalizers):
 *
 * ```ts
 * import { NodeRuntime } from '@effect/platform-node'
 *
 * serve({ services: [GreeterLive], port: 9080 }).pipe(
 *   Effect.provide(Greeting.Default), // the application Layer, built once
 *   NodeRuntime.runMain,
 * )
 * ```
 *
 * `@effect/platform-node` is the consumer's dependency (the binding keeps
 * platform deps out of its own surface), so this file demonstrates the
 * platform-free scoped form that the integration tests use.
 *
 * ── A note on `AppR` across a mixed `services` array ────────────────────────
 * One endpoint captures ONE application runtime, so every construct it serves
 * shares the SAME `AppR`. A construct's `AppR` is the explicit type param to
 * `implement` (`never` when it needs no application service). Mixing constructs
 * that share an `AppR` is fine; to serve constructs with DIFFERENT `AppR` on one
 * endpoint, declare each at the endpoint's full `AppR` (the union of every
 * construct's requirements) when you implement it.
 */
import { Effect, Layer } from 'effect'

import { type EndpointOptions, layer, type RestateError, serve } from '../src/mod.ts'
import { Greeting, GreeterLive } from './01-service.ts'
import { CounterLive } from './02-virtual-object.ts'
import { ApprovalLive } from './03-workflow.ts'

/* A single-Service endpoint with an application Layer (`AppR = Greeting`). */
export const greeterEndpointOptions: EndpointOptions<Greeting> = {
  services: [GreeterLive],
  port: 9080,
}

/* A mixed endpoint of constructs that share `AppR = never` (an Object + a
 * Workflow). They need no application service, so `appLayer` is unnecessary. */
export const mixedEndpointOptions: EndpointOptions<never> = {
  services: [CounterLive, ApprovalLive],
  port: 9081,
}

/**
 * The scoped endpoint `Layer`. `RestateError` is the failure channel (a bind /
 * listen failure); `Greeting` is the residual `AppR` the application Layer
 * discharges. Compose it into a larger Layer graph as needed.
 */
export const EndpointLayer: Layer.Layer<never, RestateError, never> = layer(
  greeterEndpointOptions,
).pipe(Layer.provide(Greeting.Default))

/**
 * The `serve` form: the long-lived entrypoint, with the application Layer
 * provided. Under `NodeRuntime.runMain` this blocks until SIGTERM and then runs
 * the server-close + application finalizers in one atomic shutdown path.
 */
export const serveProgram: Effect.Effect<never, RestateError, never> = serve(
  greeterEndpointOptions,
).pipe(Effect.provide(Greeting.Default))
