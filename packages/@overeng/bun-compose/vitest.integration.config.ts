import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

/** Keep vitest rooted at the package directory when invoked from the monorepo. */
const root = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root,
  test: {
    include: ['src/**/*.integration.test.ts'],
    testTimeout: 120000,
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
