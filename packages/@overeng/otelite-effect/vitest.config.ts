import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    // Tests spawn the real nix-built otelite binary; give them headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
