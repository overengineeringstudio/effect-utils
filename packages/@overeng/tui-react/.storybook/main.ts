import { createStorybookConfig } from '@overeng/utils/node/storybook/config'

export default createStorybookConfig({
  variant: 'tui',
  stories: ['../src/**/*.stories.@(ts|tsx)', '../examples/**/*.stories.@(ts|tsx)'],
})
