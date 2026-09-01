import { createDomStorybookConfig } from '@overeng/utils/node/storybook/config'

// No StyleX flag: the Storybook builder merges this package's `vite.config.ts`,
// which already registers the plugin. Passing it here installed a second
// instance for byte-identical output — measured, so noise rather than a defect.
export default createDomStorybookConfig({})
