import { createDomStorybookConfig } from '@overeng/utils/node/storybook/config'

/* `disableMinify` preserves component function names for the inspector display.
 * The shared factory also applies the standard server binding (0.0.0.0) and the
 * fsevents-free file-watch policy, matching the previous hand-rolled config. */
export default createDomStorybookConfig({ stories: ['../stories/*.*'], disableMinify: true })
