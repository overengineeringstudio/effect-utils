import { resolve } from 'node:path'

import { createTuiStorybookConfig } from '@overeng/utils/node/storybook/config'

const config = createTuiStorybookConfig({
  stories: ['../src/**/*.stories.@(ts|tsx)'],
})

/* Resolve megarepo internal imports used by _megarepo-renders.ts.
   Vite alias ensures the relative workspace paths work in both
   dev mode and production build regardless of runner CWD. */
const megarepoSrc = resolve(import.meta.dirname, '../../megarepo/src')

export default {
  ...config,
  viteFinal: async (viteConfig: Record<string, unknown>) => {
    const existingViteFinal = (config as { viteFinal?: (c: unknown) => Promise<unknown> }).viteFinal
    const base = existingViteFinal !== undefined ? await existingViteFinal(viteConfig) : viteConfig
    return {
      ...(base as Record<string, unknown>),
      resolve: {
        ...(((base as Record<string, unknown>).resolve as Record<string, unknown>) ?? {}),
        alias: {
          ...(((((base as Record<string, unknown>).resolve as Record<string, unknown>) ?? {})
            .alias as Record<string, unknown>) ?? {}),
          '@megarepo-internal': megarepoSrc,
        },
      },
    }
  },
}
