import { createDomStorybookConfig } from '@overeng/utils-storybook/config'

export default {
  ...createDomStorybookConfig({ a11y: true }),
  previewHead: (head: string) =>
    `${head}<link rel="icon" href="./favicon.svg" type="image/svg+xml">`,
}
