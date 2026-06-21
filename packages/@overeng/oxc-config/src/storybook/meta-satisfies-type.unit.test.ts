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

const rule = plugin.rules['storybook/meta-satisfies-type']

tsRuleTester.run('storybook-meta-satisfies-type', rule, {
  valid: [
    { code: `export default { title: 'Button' } satisfies Meta` },
    {
      code: `
const meta = { title: 'Button' } satisfies Meta
export default meta
`,
    },
    // Not an object Meta -> ignored
    { code: `export default someImportedMeta` },
  ],
  invalid: [
    {
      code: `export default { title: 'Button' }`,
      errors: [{ messageId: 'metaShouldSatisfyType' }],
    },
    {
      code: `export default { title: 'Button' } as Meta`,
      errors: [{ messageId: 'metaShouldSatisfyType' }],
    },
    {
      code: `
const meta = { title: 'Button' }
export default meta
`,
      errors: [{ messageId: 'metaShouldSatisfyType' }],
    },
  ],
})
