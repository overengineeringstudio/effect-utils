import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    server: { deps: { inline: ['@effect/vitest'] } },
    // Pty tests spawn real child processes; give them headroom but stay strict.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Force serial execution within a file: each test isolates state via
    // PTY_SESSION_DIR, but we still want predictable resource usage.
    fileParallelism: false,
  },
})
