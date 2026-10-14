import { defineConfig } from 'vitest/config'

import { createStoryGateConfig } from '@overeng/utils-storybook/gate'

// Story discovery follows .storybook/main.ts, including the typechecked src/stories tree.
export default defineConfig(createStoryGateConfig({}))
