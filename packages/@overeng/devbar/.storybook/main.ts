import type { InlineConfig } from 'vite'

import { createDomStorybookConfig } from '@overeng/utils-storybook/config'

export default createDomStorybookConfig<InlineConfig>({
  a11y: true,
  viteFinal: async (config) => ({
    ...config,
    // A published Storybook is an explicit diagnostic host, not the production fixture.
    define: { ...config.define, 'import.meta.env.VITE_HOST_DIAGNOSTICS': JSON.stringify('true') },
    resolve: {
      ...config.resolve,
      dedupe: [...(config.resolve?.dedupe ?? []), 'react', 'react-dom'],
    },
  }),
})
