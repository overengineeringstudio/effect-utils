import { defineConfig, mergeConfig } from 'vitest/config'

import { createStoryGateConfig } from '@overeng/utils-storybook/gate'
import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

export default defineConfig(
  mergeConfig(createStoryGateConfig({ plugins: [createStylexVitePlugins()] }), {
    test: { setupFiles: ['./vitest.gate.setup.ts'] },
  }),
)
