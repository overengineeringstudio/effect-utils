import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // These React render/dispatch/unmount tests run in <1s locally, but the first
    // one in a fresh CI worker can pay enough transform/JIT/reconciliation cost
    // under load to exceed the 5s default. 20s absorbs that without masking a hang.
    testTimeout: 20000,
  },
})
