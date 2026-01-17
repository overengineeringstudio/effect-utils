/**
 * Playwright config factory for browser integration tests.
 *
 * @module
 */

import { createServer } from 'node:net'

import type * as PlaywrightTest from '@playwright/test'

import { shouldNeverHappen } from '../../isomorphic/mod.ts'
/** Web server configuration for Vite. */
export interface WebServerConfig {
  /** Command to start the dev server (use `{{port}}` placeholder) */
  command: string
  /** Working directory for the command */
  cwd?: string
  /** Timeout for server startup in ms (default: 30_000) */
  timeout?: number
  /**
   * Environment variable name to read/write the port.
   * This ensures port stability across multiple config evaluations.
   * On first evaluation, finds an available port and stores it in this env var.
   * On subsequent evaluations, reads from the env var (same port).
   * Default: `PW_TEST_PORT`
   */
  portEnvVar?: string
}

/** Options for creating a Playwright test configuration. */
export interface PlaywrightConfigOptions {
  /**
   * Playwright module import from the consumer.
   *
   * This must be passed as a wildcard import (for example:
   * `import * as playwrightTest from '@playwright/test'`) so the config uses the
   * consumer's single Playwright instance. When `@playwright/test` is imported
   * from both a shared package and the consumer, Playwright throws
   * `Error: Requiring @playwright/test second time` because it detects multiple
   * physical installs. Passing the consumer import prevents the duplicate load.
   *
   * References:
   * - https://github.com/microsoft/playwright/issues/15819
   * - https://github.com/microsoft/playwright/issues/31478
   * - https://github.com/oven-sh/bun/issues/3835
   */
  playwrightTest: typeof PlaywrightTest

  /** Test directory (e.g. './src/browser/__tests__') */
  testDir: string

  /** Test file pattern (default: `**\/*.pw.test.ts`) */
  testMatch?: string | string[]

  /** Patterns to ignore (merged with default ignores: dist, node_modules) */
  testIgnore?: string | string[]

  /** Web server config for Vite dev server */
  webServer: WebServerConfig

  /** Timeout for each test in ms (default: 60_000) */
  timeout?: number

  /** Number of workers (default: 1) */
  workers?: number
}


/** Find an available port for the dev server. */
const findAvailablePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address()
      if (address && typeof address === 'object') {
        const port = address.port
        srv.close(() => resolve(port))
      } else {
        srv.close(() => reject(new Error('Failed to resolve available port')))
      }
    })
  })

/**
 * Create a Playwright config for browser integration tests.
 *
 * @example
 * ```typescript
 * // playwright.config.ts
 * import { createPlaywrightConfig } from '@overeng/utils/node/playwright'
 *
 * import * as playwrightTest from '@playwright/test'
 *
 * export default createPlaywrightConfig({
 *   playwrightTest,
 *   testDir: './src/browser/__tests__',
 *   webServer: {
 *     command:
 *       './node_modules/.bin/vite --config src/browser/__tests__/vite.config.ts --port {{port}}',
 *   },
 * })
 * ```
 */
export const createPlaywrightConfig = async (
  options: PlaywrightConfigOptions,
): Promise<PlaywrightTest.PlaywrightTestConfig> => {
  const { playwrightTest } = options
  const { defineConfig, devices } = playwrightTest
  const {
    testDir,
    testMatch = '**/*.pw.test.ts',
    testIgnore: extraIgnore,
    timeout = 60_000,
    workers = 1,
    webServer: webServerConfig,
  } = options

  const defaultIgnore = ['**/dist/**', '**/node_modules/**']
  const testIgnore = extraIgnore
    ? [...defaultIgnore, ...(Array.isArray(extraIgnore) ? extraIgnore : [extraIgnore])]
    : defaultIgnore

  const {
    command,
    cwd,
    timeout: serverTimeout = 30_000,
    portEnvVar = 'PW_TEST_PORT',
  } = webServerConfig

  // Resolve port: read from env var if set, otherwise find available port and store it
  const envPort = process.env[portEnvVar]
  const port = envPort ? Number.parseInt(envPort, 10) : await findAvailablePort()

  if (!Number.isFinite(port)) {
    return shouldNeverHappen(
      `Failed to resolve port for Playwright webServer (portEnvVar: ${portEnvVar})`,
    )
  }

  // Store port in env var for subsequent config evaluations
  if (!envPort) {
    process.env[portEnvVar] = String(port)
  }

  const url = `http://127.0.0.1:${port}`
  const resolvedCommand = command.replace(/\{\{port\}\}/g, String(port))

  const config: PlaywrightTestConfig = {
    testDir,
    testMatch,
    testIgnore,
    reporter: process.env.CI ? 'line' : 'list',

    timeout,
    ...(process.env.CI ? { maxFailures: 1 } : {}),
    workers,
    fullyParallel: false,

    use: {
      baseURL: url,
      headless: !process.env.PW_HEADFUL,
      viewport: { width: 1280, height: 800 },
      trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
      screenshot: 'off',
      video: 'off',
    },

    projects: [
      {
        name: 'chromium',
        use: { ...devices['Desktop Chrome'] },
      },
    ],

    webServer: {
      command: resolvedCommand,
      ...(cwd ? { cwd } : {}),
      url,
      timeout: serverTimeout,
      stdout: 'pipe',
      stderr: 'pipe',
      reuseExistingServer: !process.env.CI,
    },
  }

  return defineConfig(config)
}
