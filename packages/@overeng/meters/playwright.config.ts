import { fileURLToPath } from 'node:url'

import { createPlaywrightConfig } from '@overeng/utils/node/playwright/config'

const STORYBOOK_WEB_SERVER_TIMEOUT_MS = 120_000

export default createPlaywrightConfig({
  testDir: './e2e',
  testMatch: ['**/*.pw.test.ts'],
  webServer: {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command:
      'node node_modules/storybook/dist/bin/dispatcher.js dev --port {{port}} --no-open --ci',
    timeout: STORYBOOK_WEB_SERVER_TIMEOUT_MS,
  },
})
