import * as Fs from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, expect, vi } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { createPlaywrightConfig } from './mod.ts'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  mkdirSync: vi.fn(),
}))

Vitest.describe('createPlaywrightConfig', () => {
  beforeEach(() => {
    vi.stubEnv('PW_TEST_PORT', '43210')
    // Keep config assertions independent of the filesystem and free-port probing.
    vi.mocked(Fs.mkdirSync).mockClear()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  Vitest.it('passes web server environment variables to Playwright', async () => {
    const config = await createPlaywrightConfig({
      testDir: './tests',
      webServer: {
        command: 'vite --port {{port}}',
        env: {
          CATALOG_API_URL: 'http://127.0.0.1:43210',
          DEVENV_TASK_PASSTHROUGH: '1',
        },
      },
    })

    expect(config.webServer).toMatchObject({
      env: {
        CATALOG_API_URL: 'http://127.0.0.1:43210',
        DEVENV_TASK_PASSTHROUGH: '1',
      },
    })

    expect(config.use).toMatchObject({
      trace: 'retain-on-failure',
      screenshot: 'only-on-failure',
      video: 'off',
    })
    expect(config.retries ?? 0).toBe(0)
  })

  Vitest.it(
    'captures Chromium network events only in CI, outside cleared test output',
    async () => {
      vi.stubEnv('CI', 'true')
      const config = await createPlaywrightConfig({
        testDir: './tests',
        webServer: { command: 'vite --port {{port}}' },
      })

      expect(config.outputDir).toBe(resolve('test-results/tests'))
      expect(config.use?.launchOptions?.args).toEqual([
        `--log-net-log=${resolve('test-results/network/chromium-netlog.json')}`,
        '--net-log-capture-mode=Default',
      ])
      expect(Fs.mkdirSync).toHaveBeenCalledWith(resolve('test-results/network'), {
        recursive: true,
      })
      expect(config.retries ?? 0).toBe(0)
    },
  )

  Vitest.it('leaves local browser launches and test output unchanged', async () => {
    vi.stubEnv('CI', undefined)
    const config = await createPlaywrightConfig({
      testDir: './tests',
      webServer: { command: 'vite --port {{port}}' },
    })

    expect(config.outputDir).toBeUndefined()
    expect(config.use?.launchOptions).toBeUndefined()
    expect(Fs.mkdirSync).not.toHaveBeenCalled()
    expect(config.retries ?? 0).toBe(0)
  })
})
