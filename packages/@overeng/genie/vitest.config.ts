import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.pw.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // TODO(#1298): Remove after the tsgo/Vite handle lifecycle has a principled fix.
    teardownTimeout: 30_000,
  },
})
