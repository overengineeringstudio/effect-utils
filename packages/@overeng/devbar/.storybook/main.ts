import type { InlineConfig } from 'vite'

import { createDomStorybookConfig } from '@overeng/utils-storybook/config'

export default createDomStorybookConfig<InlineConfig>({
  a11y: true,
  viteFinal: async (config) => ({
    ...config,
    resolve: {
      ...config.resolve,
      dedupe: [...(config.resolve?.dedupe ?? []), 'react', 'react-dom'],
    },
  }),
})
