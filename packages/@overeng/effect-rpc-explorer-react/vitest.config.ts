import { defineConfig } from 'vitest/config'

// Unit tests exercise projection and normalized-value logic only. Keeping TSX
// rendering in Storybook avoids loading long-lived StyleX compiler workers.

export default defineConfig({
  test: {
    exclude: ['**/dist/**', '**/node_modules/**'],
    // This small suite exits cleanly in one worker; parallel files leave duplicate file handles open in Vitest.
    maxWorkers: 1,
    server: { deps: { inline: ['@effect/vitest'] } },
  },
})
