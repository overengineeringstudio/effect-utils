import * as playwrightTest from '@playwright/test'

import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  playwrightTest,
  testDir: './tests',
  testMatch: '**/*.playwright.ts',
  webServer: {
    command: 'pnpm dev --port {{port}}',
  },
})
