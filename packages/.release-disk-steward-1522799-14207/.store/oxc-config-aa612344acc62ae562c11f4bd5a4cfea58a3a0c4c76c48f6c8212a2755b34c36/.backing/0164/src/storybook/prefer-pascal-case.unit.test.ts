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

const rule = plugin.rules['storybook/prefer-pascal-case']

tsRuleTester.run('storybook-prefer-pascal-case', rule, {
  valid: [
    {
      code: `
export default { title: 'Button' }
export const Primary = {}
export const SecondaryButton = {}
`,
    },
    // Underscore-prefixed exports are exempt
    {
      code: `
export default { title: 'Button' }
export const _hidden = {}
`,
    },
    // Non-story exports excluded by config are exempt
    {
      code: `
export default { title: 'Button', includeStories: ['Primary'] }
export const Primary = {}
export const someData = {}
`,
    },
    // Legacy storiesOf -> exempt
    {
      code: `
import { storiesOf } from '@storybook/react'
export const primary = {}
`,
    },
  ],
  invalid: [
    {
      code: `
export default { title: 'Button' }
export const primary = {}
`,
      errors: [{ messageId: 'usePascalCase' }],
    },
    {
      code: `
export default { title: 'Button' }
export const primary_button = {}
`,
      errors: [{ messageId: 'usePascalCase' }],
    },
  ],
})
