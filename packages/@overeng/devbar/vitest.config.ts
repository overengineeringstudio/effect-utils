import { defineConfig } from 'vitest/config'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

export default defineConfig({
  plugins: [createStylexVitePlugins()],
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.unit.test.ts', 'src/**/*.unit.test.tsx'],
    maxWorkers: 1,
  },
})
