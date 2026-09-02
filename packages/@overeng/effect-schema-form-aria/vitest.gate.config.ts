import { defineConfig } from 'vitest/config'

import { createStoryGateConfig } from '@overeng/utils/node/storybook/gate'
import { createStylexVitePlugins } from '@overeng/utils/node/stylex'

// Run through `runStoryGate`, not directly: baselines are derived from a git ref
// on demand and never committed, so this config needs the runner to tell it
// which ref-derived directory to compare against.
//
// The StyleX plugin goes through `plugins` rather than being merged into the
// returned config. Vitest treats this file as the Vite config for the run, so
// `vite.config.ts` is never loaded — unlike a Storybook build, where the builder
// merges it — and without the compiler transform the stories throw
// `Unexpected 'stylex.keyframes' call at runtime`. Merging at the root happened
// to work here only because this package declares no themes, so the factory
// returned a bare project config and the merge target *was* the project; the
// same code silently stopped applying for a two-theme consumer. No `entries`:
// the virtual stylesheet is a build-only concern and this run is served, not
// bundled.
export default defineConfig(
  createStoryGateConfig({
    plugins: [createStylexVitePlugins({ useCSSLayers: { before: ['overeng.reset'] } })],
  }),
)
