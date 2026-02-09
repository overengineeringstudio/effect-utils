import { createStorybookConfig } from '@overeng/utils/node/storybook/config'

export default createStorybookConfig({ stories: ['../stories/*.*'], disableMinify: true })
