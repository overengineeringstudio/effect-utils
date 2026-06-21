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

const rule = plugin.rules['storybook/csf-component']

tsRuleTester.run('storybook-csf-component', rule, {
  valid: [
    {
      code: `
const Button = () => null
export default { title: 'Button', component: Button } satisfies Meta
`,
    },
    {
      code: `
const Button = () => null
const meta = { title: 'Button', component: Button }
export default meta
`,
    },
    // Not a Meta object -> ignored
    { code: `export default 42` },
  ],
  invalid: [
    {
      code: `export default { title: 'Button' } satisfies Meta`,
      errors: [{ messageId: 'missingComponentProperty' }],
    },
    {
      code: `
const meta = { title: 'Button' }
export default meta
`,
      errors: [{ messageId: 'missingComponentProperty' }],
    },
  ],
})
