import { defineConfig, mergeConfig } from 'vitest/config'

import { createStoryGateConfig } from '@overeng/utils/node/storybook/gate'
import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

// Run through `runStoryGate`, not directly: baselines are derived from a git ref
// on demand and never committed, so this config needs the runner to tell it
// which ref-derived directory to compare against.
//
// The StyleX plugin has to be here rather than inherited. Vitest treats this
// file as the Vite config for the run, so `vite.config.ts` is never loaded —
// unlike a Storybook build, where the builder merges it. Without the compiler
// transform the stories throw `Unexpected 'stylex.keyframes' call at runtime`.
// No `entries`: the virtual stylesheet is a build-only concern and this run is
// served, not bundled.
export default defineConfig(
  mergeConfig(createStoryGateConfig({}), {
    plugins: [createStylexVitePlugins()],
  }),
)
