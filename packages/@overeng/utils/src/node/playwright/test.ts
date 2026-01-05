/**
 * Effect-native Playwright test helpers.
 *
 * Provides `withTestCtx` and `makeWithTestCtx` for wrapping Effects with
 * Playwright test infrastructure and automatic layer provision.
 *
 * @module
 */

import { FetchHttpClient } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import type { BrowserContext, Page } from '@playwright/test'
import { test } from '@playwright/test'
import { ConfigProvider, Effect, Layer, Logger, LogLevel, type Config } from 'effect'

import { OtelPlaywrightLive } from './otel.ts'
import { PwBrowserContext, PwPage } from './tags.ts'

/** Config provider for Playwright tests (constant-case environment variables). */
const testEnvConfigProvider = ConfigProvider.fromEnv({ pathDelim: '_', seqDelim: ',' })

/** Layer that installs the Playwright test config provider. */
export const TestEnvConfigLive = testEnvConfigProvider.pipe(Layer.setConfigProvider)

/**
 * Load a config schema from process.env in Playwright tests.
 */
export const loadEnvConfig = Effect.fn('pw.loadEnvConfig')(<TA>(config: Config.Config<TA>) =>
  testEnvConfigProvider.load(config),
)

/** Playwright test fixtures passed to each test function. */
export interface PlaywrightFixtures {
  page: Page
  context: BrowserContext
}

export interface WithTestCtxParams<ROut, E1, RIn> {
  /** Custom layers to provide (merged with defaults). */
  makeLayer?: () => Layer.Layer<ROut, E1, RIn>
  /**
   * Test timeout in milliseconds. Sets Playwright's native test timeout via `test.setTimeout()`.
   * @default 120_000 (2 minutes)
   */
  timeout?: number
  /**
   * Pre-test setup function that runs before the Effect. Use for conditional test skipping
   * via `test.skip()` or other Playwright test configuration.
   *
   * @example
   * ```typescript
   * Pw.withTestCtx({ page, context }, {
   *   setup: () => { if (!process.env.RUN_LIVE_TESTS) test.skip() },
   * })(Effect.gen(...))
   * ```
   */
  setup?: () => void
  /**
   * Whether to enable debug logging. Defaults to true.
   */
  debugLogs?: boolean
  /**
   * Whether to use pretty logger (recommended for VS Code). Auto-detected by default.
   */
  prettyLogger?: boolean
  /**
   * Whether to include OTEL tracing. Defaults to true.
   */
  otel?: boolean
}

/**
 * Platform layers for filesystem, path, and HTTP client access.
 */
const DefaultLayers = Layer.mergeAll(NodeContext.layer, FetchHttpClient.layer, TestEnvConfigLive)

/** Default timeout for Playwright tests (2 minutes). */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Factory to create a pre-configured `withTestCtx` with custom layers.
 *
 * Use this at the top of test files that need specific dependencies beyond the defaults.
 *
 * @example
 * ```typescript
 * import { Pw } from '@overeng/utils/node/playwright'
 * import { MyCustomLayer } from './layers.ts'
 *
 * const withTestCtx = Pw.makeWithTestCtx({
 *   makeLayer: () => MyCustomLayer,
 * })
 *
 * test('my test', ({ page, context }) =>
 *   withTestCtx({ page, context })(
 *     Effect.gen(function* () {
 *       yield* Pw.Page.goto({ url: 'https://example.com' })
 *     })
 *   )
 * )
 * ```
 */
export const makeWithTestCtx =
  <ROut = never, E1 = never, RIn = never>(params: WithTestCtxParams<ROut, E1, RIn>) =>
  (fixtures: PlaywrightFixtures) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Promise<A> =>
    runWithTestCtx(fixtures, params, self)

/**
 * Wrap an Effect with Playwright test infrastructure.
 *
 * Provides default layers:
 * - `PwPage` + `PwBrowserContext` (from Playwright fixtures)
 * - `OtelPlaywrightLive` (tracing, when OTEL endpoint is configured)
 * - `NodeContext.layer` (filesystem, path, etc.)
 * - `FetchHttpClient.layer`
 * - `Logger.minimumLogLevel(LogLevel.Debug)` (debug logs enabled by default)
 *
 * @example
 * ```typescript
 * import { test } from '@playwright/test'
 * import { Pw } from '@overeng/utils/node/playwright'
 *
 * test('basic navigation', ({ page, context }) =>
 *   Pw.withTestCtx({ page, context })(
 *     Effect.gen(function* () {
 *       yield* Pw.Page.goto({ url: 'https://example.com' })
 *     })
 *   )
 * )
 * ```
 */
export const withTestCtx =
  (fixtures: PlaywrightFixtures, params: WithTestCtxParams<never, never, never> = {}) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Promise<A> =>
    runWithTestCtx(fixtures, params, self)

/**
 * Internal implementation that handles layer composition and Effect execution.
 */
const runWithTestCtx = <ROut, E1, RIn, A, E, R>(
  fixtures: PlaywrightFixtures,
  params: WithTestCtxParams<ROut, E1, RIn>,
  self: Effect.Effect<A, E, R>,
): Promise<A> => {
  const {
    makeLayer,
    timeout = DEFAULT_TIMEOUT_MS,
    setup,
    debugLogs = true,
    prettyLogger: prettyLoggerOption,
    otel = true,
  } = params

  // Set Playwright's native test timeout
  test.setTimeout(timeout)

  // Run pre-test setup (e.g., conditional skipping)
  setup?.()

  const { page, context } = fixtures

  // Playwright fixture layers (PwPage, PwBrowserContext)
  const playwrightLayers = Layer.mergeAll(PwPage.layer(page), PwBrowserContext.layer(context))

  // OTEL layer (optional)
  const otelLayer = otel ? OtelPlaywrightLive : Layer.empty

  // User-provided layers (if any)
  const userLayer = makeLayer?.() ?? Layer.empty

  // Use pretty logger in VS Code for better readability (VSCODE_PID is set by VS Code extensions)
  const usePrettyLogger = prettyLoggerOption ?? process.env.VSCODE_PID !== undefined

  const loggerLayer = debugLogs
    ? usePrettyLogger
      ? Layer.mergeAll(
          Logger.minimumLogLevel(LogLevel.Debug),
          Logger.replace(Logger.defaultLogger, Logger.prettyLogger()),
        )
      : Logger.minimumLogLevel(LogLevel.Debug)
    : Layer.empty

  const combinedLayer = Layer.mergeAll(playwrightLayers, otelLayer, DefaultLayers, userLayer).pipe(
    Layer.provide(loggerLayer),
  )

  const effect = self.pipe(Effect.provide(combinedLayer), Effect.scoped)

  return Effect.runPromise(effect as Effect.Effect<A>)
}
