import { createStorybookConfig } from '@overeng/utils/node/storybook/config'

export default createStorybookConfig({
  variant: 'tui',
  additionalOptimizeDepsInclude: ['@effect/cli > ini', '@effect/cli > toml'],
})
