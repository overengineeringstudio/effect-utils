import { fileURLToPath } from 'node:url'

import * as playwrightTest from '@playwright/test'

import { createPlaywrightConfig } from './src/node/playwright/config.ts'

export default createPlaywrightConfig({
  playwrightTest,
  testDir: './src/browser/__tests__',
  testIgnore: ['**/fixtures/**'],
  webServer: {
    /**
     * Ensure the Vite command resolves relative to this package,
     * even when the Playwright CLI runs from the workspace root.
     */
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command:
      './node_modules/.bin/vite --config src/browser/__tests__/vite.config.ts --port {{port}}',
  },

})
