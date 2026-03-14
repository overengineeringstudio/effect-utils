import { fileURLToPath } from 'node:url'

import { createPlaywrightConfig } from './src/node/playwright/config/mod.ts'

export default createPlaywrightConfig({
  testDir: './src/browser/__tests__',
  testIgnore: ['**/fixtures/**'],
  webServer: {
    /**
     * Run Vite from the package cwd through `pnpm exec` so it resolves
     * against the active workspace topology instead of the ambient PATH.
     */
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command: 'pnpm exec vite --config src/browser/__tests__/vite.config.ts --port {{port}}',
  },
})
