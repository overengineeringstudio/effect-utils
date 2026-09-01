import { createDomStorybookConfig } from '@overeng/utils/node/storybook/config'

// No StyleX flag: the Storybook builder merges this package's `vite.config.ts`,
// which already registers the plugin. Passing it here installed a second
// instance for byte-identical output — measured, so noise rather than a defect.
//
// `a11y` is what makes `parameters.a11y.test: 'error'` mean anything; without
// the addon registered the gate's accessibility check passes everything.
export default createDomStorybookConfig({ a11y: true })
