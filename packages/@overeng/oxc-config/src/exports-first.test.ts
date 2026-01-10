import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { RuleTester as ESLintRuleTester } from 'eslint'
import { afterAll, describe, it } from 'vitest'

import plugin from './mod.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it
ESLintRuleTester.describe = describe
ESLintRuleTester.it = it

const ruleTester = new ESLintRuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
})

const rule = plugin.rules['exports-first']

ruleTester.run('exports-first: valid exports before non-exports', rule, {
  valid: [
    {
      code: `
export const publicApi = () => {}
export const anotherExport = 42
const helper = () => {}
const internal = 'value'
`,
    },
    {
      code: `
export const a = 1
export const b = 2
export function c() {}
`,
    },
    {
      code: `
const a = 1
const b = 2
function c() {}
`,
    },
  ],
  invalid: [],
})

tsRuleTester.run('exports-first: valid imports and type exports', rule, {
  valid: [
    {
      code: `
import { something } from 'module'
import type { Type } from 'types'
export const a = something
const b = 2
`,
    },
    {
      code: `
export const a = 1
const b = 2
export type { MyType } from 'types'
`,
    },
    {
      code: `
import type { SomeType } from 'types'
export type { SomeType } from 'types'
export { something } from 'module'
export * from 'other'
`,
    },
    {
      code: `
export const a = 1
interface InternalInterface {}
type InternalType = string
export const b = 2
`,
    },
    {
      code: `
type MyType = { value: number }
export const thing: MyType = { value: 42 }
`,
    },
    {
      code: `
const meta = { title: 'Test' }
export default meta
type Story = { args: object }
export const Default: Story = { args: {} }
export const Another: Story = { args: {} }
`,
    },
  ],
  invalid: [],
})

ruleTester.run('exports-first: valid re-exports and classes', rule, {
  valid: [
    {
      code: `
export const a = 1
const b = 2
export { something } from 'module'
export * from 'other'
`,
    },
    {
      code: `
export default function main() {}
export const helper = () => {}
const internal = 'value'
`,
    },
    {
      code: `
export class PublicClass {}
export const util = () => {}
class InternalClass {}
`,
    },
    {
      code: `
const MAX_OPTIONS = 5
export const LiteralField = () => MAX_OPTIONS
`,
    },
    {
      code: `
const helper = (x) => x * 2
export const publicApi = (n) => helper(n)
`,
    },
    {
      code: `
const CONFIG = { max: 10 }
const helper = () => CONFIG.max
export const publicA = () => helper()
export const publicB = () => CONFIG.max
`,
    },
    {
      code: `
const helper = () => 42
export const first = () => 1
export const second = () => helper()
`,
    },
  ],
  invalid: [],
})

ruleTester.run('exports-first: invalid cases', rule, {
  valid: [],
  invalid: [
    {
      code: `
const helper = () => {}
export const publicApi = () => {}
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
function helper() {}
export function publicApi() {}
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
const internal = 1
export const a = 2
export const b = 3
`,
      errors: [{ messageId: 'exportAfterNonExport' }, { messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
const helper = 'internal'
export default function main() {}
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
class InternalClass {}
export class PublicClass {}
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
const before = 1
export const middle = 2
const after = 3
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
const unrelatedHelper = () => 'not used by export'
export const publicApi = () => 'does not use helper'
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
    {
      code: `
export const first = () => 1
const helper = () => 42
export const second = () => 2
`,
      errors: [{ messageId: 'exportAfterNonExport' }],
    },
  ],
})
