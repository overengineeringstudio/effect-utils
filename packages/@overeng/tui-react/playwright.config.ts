import { fileURLToPath } from 'node:url'

import { createPlaywrightConfig } from '@overeng/utils/node/playwright'

export default createPlaywrightConfig({
  testDir: './e2e',
  webServer: {
    cwd: fileURLToPath(new URL('.', import.meta.url)),
    command:
      'CACHE_DIR="$PWD/../../../.devenv/storybook-cache" pnpm storybook --port {{port}} --no-open',
    timeout: 120_000,
  },
})
