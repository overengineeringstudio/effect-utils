import { defineConfig } from 'vitest/config'

import { createStoryGateConfig } from '@overeng/utils/node/storybook/gate'

// Run through `runStoryGate`, not directly: baselines are derived from a git ref
// on demand and never committed, so this config needs the runner to tell it
// which ref-derived directory to compare against.
export default defineConfig(createStoryGateConfig({}))
