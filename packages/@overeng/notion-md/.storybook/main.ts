import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'

export default createTuiStorybookConfig({
  additionalOptimizeDepsInclude: ['@effect/cli > ini', '@effect/cli > toml'],
})
