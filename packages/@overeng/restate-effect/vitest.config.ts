import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    /* The integration test boots a real restate-server child process and
     * registers an SDK deployment, so give it generous headroom. */
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Each file keeps its own module state, native server, ephemeral ports and temp directory.
    // Bound concurrent server lifecycles rather than serializing all integration files.
    fileParallelism: true,
    maxWorkers: 2,
    isolate: true,
  },
})
