import { defineConfig } from 'vitest/config'

import { createStoryGateConfig } from '@overeng/utils/node/storybook/gate'
import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

export default defineConfig(
  createStoryGateConfig({
    plugins: [createStylexVitePlugins({ useCSSLayers: { before: ['overeng.reset'] } })],
  }),
)
