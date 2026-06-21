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

const rule = plugin.rules['storybook/default-exports']

tsRuleTester.run('storybook-default-exports', rule, {
  valid: [
    { code: `export default { title: 'Button' }` },
    {
      code: `
const meta = { title: 'Button' }
export default meta
export const Primary = {}
`,
    },
    // Legacy storiesOf API -> exempt
    {
      code: `
import { storiesOf } from '@storybook/react'
storiesOf('Button', module).add('primary', () => null)
`,
    },
    // CSF4 config.meta() style -> exempt
    {
      code: `
const meta = config.meta({ title: 'Button' })
`,
    },
  ],
  invalid: [
    {
      code: `export const Primary = {}`,
      errors: [{ messageId: 'shouldHaveDefaultExport' }],
    },
    {
      code: `
import type { Meta } from '@storybook/react'
export const Primary = {}
`,
      errors: [{ messageId: 'shouldHaveDefaultExport' }],
    },
  ],
})
