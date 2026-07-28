import { defineConfig } from 'vitest/config'

// The root project config does not resolve correctly from this package task's cwd.
export default defineConfig({
  test: {
    include: ['src/**/*.unit.test.ts', 'src/**/*.unit.test.tsx'],
  },
})
