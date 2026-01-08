import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  testDir: './tests',
  testMatch: '**/*.playwright.ts',
  webServer: {
    command: 'pnpm dev --port {{port}}',
  },
})
