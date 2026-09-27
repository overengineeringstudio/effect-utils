import { createTuiStorybookConfig } from '@overeng/utils-storybook/config'

export default createTuiStorybookConfig({
  stories: ['../src/**/*.stories.@(ts|tsx)', '../examples/**/*.stories.@(ts|tsx)'],
})
