import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, it } from 'vitest'

import plugin from '../mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const tsRuleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module', parser: tsParser },
})

const rule = plugin.rules['storybook/story-exports']

tsRuleTester.run('storybook-story-exports', rule, {
  valid: [
    {
      code: `
export default { title: 'Button' }
export const Primary = {}
`,
    },
    // No Meta -> not a CSF story file -> exempt
    { code: `export const helper = () => null` },
    // Legacy storiesOf -> exempt
    {
      code: `
import { storiesOf } from '@storybook/react'
export default { title: 'Button' }
`,
    },
    // excludeStories filters out the only export, but a real story remains
    {
      code: `
export default { title: 'Button', excludeStories: /.*Data$/ }
export const Primary = {}
export const mockData = {}
`,
    },
  ],
  invalid: [
    {
      code: `export default { title: 'Button' }`,
      errors: [{ messageId: 'shouldHaveStoryExport' }],
    },
    {
      code: `
export default { title: 'Button', excludeStories: ['Primary'] }
export const Primary = {}
`,
      errors: [{ messageId: 'shouldHaveStoryExportWithFilters' }],
    },
  ],
})
