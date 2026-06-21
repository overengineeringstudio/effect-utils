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

const rule = plugin.rules['storybook/hierarchy-separator']

tsRuleTester.run('storybook-hierarchy-separator', rule, {
  valid: [
    { code: `export default { title: 'Atoms/Button' }` },
    { code: `export default { title: 'Button' }` },
    // No title -> nothing to check
    { code: `export default { component: Button }` },
  ],
  invalid: [
    {
      code: `export default { title: 'Atoms|Button' }`,
      output: `export default { title: 'Atoms/Button' }`,
      errors: [{ messageId: 'deprecatedHierarchySeparator' }],
    },
    {
      code: `
const meta = { title: 'Design System|Atoms|Button' }
export default meta
`,
      output: `
const meta = { title: 'Design System/Atoms/Button' }
export default meta
`,
      errors: [{ messageId: 'deprecatedHierarchySeparator' }],
    },
  ],
})
