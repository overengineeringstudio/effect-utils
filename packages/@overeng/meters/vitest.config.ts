import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.unit.test.ts', 'src/**/*.unit.test.tsx'],
    maxWorkers: 1,
  },
})
