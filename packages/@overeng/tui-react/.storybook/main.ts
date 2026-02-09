import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'

export default createTuiStorybookConfig({
  stories: ['../src/**/*.stories.@(ts|tsx)', '../examples/**/*.stories.@(ts|tsx)'],
})
