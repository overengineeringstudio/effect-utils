import { createTuiStorybookConfig } from '@overeng/utils-storybook/config'

export default createTuiStorybookConfig({
  additionalOptimizeDepsInclude: ['@effect/cli > ini', '@effect/cli > toml'],
})
