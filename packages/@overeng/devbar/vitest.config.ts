import { defineConfig } from 'vitest/config'

import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

// Static collection skips transforms because the StyleX plugin keeps `vitest list`
// alive after its report is complete.
const plugins = process.argv.includes('--staticParse') === true ? [] : [createStylexVitePlugins()]

export default defineConfig({
  plugins,
  test: {
    environment: 'happy-dom',
    include: ['src/**/*.unit.test.ts', 'src/**/*.unit.test.tsx'],
    maxWorkers: 1,
  },
})
