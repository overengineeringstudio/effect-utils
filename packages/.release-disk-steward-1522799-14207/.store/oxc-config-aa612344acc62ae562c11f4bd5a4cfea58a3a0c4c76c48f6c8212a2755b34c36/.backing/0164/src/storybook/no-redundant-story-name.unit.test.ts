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

const rule = plugin.rules['storybook/no-redundant-story-name']

tsRuleTester.run('storybook-no-redundant-story-name', rule, {
  valid: [
    // Non-redundant explicit name
    { code: `export const Primary = { name: 'Custom Name' }` },
    // No name property
    { code: `export const Primary = {}` },
    // CSF2 non-redundant
    {
      code: `
export const Primary = {}
Primary.storyName = 'Custom Name'
`,
    },
  ],
  invalid: [
    // CSF3 redundant: 'Primary' === storyNameFromExport('Primary')
    {
      code: `export const Primary = { name: 'Primary' }`,
      output: `export const Primary = {  }`,
      errors: [{ messageId: 'storyNameIsRedundant' }],
    },
    {
      code: `export const PrimaryButton = { storyName: 'Primary Button' }`,
      output: `export const PrimaryButton = {  }`,
      errors: [{ messageId: 'storyNameIsRedundant' }],
    },
    // CSF2 redundant
    {
      code: `
export const Primary = {}
Primary.storyName = 'Primary'
`,
      output: `
export const Primary = {}

`,
      errors: [{ messageId: 'storyNameIsRedundant' }],
    },
  ],
})
