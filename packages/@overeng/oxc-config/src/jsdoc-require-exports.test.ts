import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { test } from 'vitest'

import { jsdocRequireExportsRule } from './jsdoc-require-exports.ts'

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
})

const tsRuleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tseslint.parser,
  },
})

test('overeng/jsdoc-require-exports (value exports)', () => {
  ruleTester.run('overeng/jsdoc-require-exports (value exports)', jsdocRequireExportsRule, {
    valid: [
      {
        name: 'allows exported const without JSDoc',
        code: `export const publicApi = () => {}`,
      },
      {
        name: 'allows exported function without JSDoc',
        code: `export function doSomething() {}`,
      },
      {
        name: 'allows export default without JSDoc',
        code: `export default function main() {}`,
      },
      {
        name: 'allows exported class without JSDoc',
        code: `export class MyClass {}`,
      },
      {
        name: 'allows named re-exports without JSDoc',
        code: `export { something } from 'module'`,
      },
    ],
    invalid: [],
  })
})

test('overeng/jsdoc-require-exports (wildcard exports)', () => {
  ruleTester.run('overeng/jsdoc-require-exports (wildcard exports)', jsdocRequireExportsRule, {
    valid: [
      {
        name: 'allows plain wildcard re-export without JSDoc',
        code: `export * from 'utils'`,
      },
      {
        name: 'allows named wildcard export with JSDoc',
        code: `
/** Re-exports utils namespace */
export * as utils from 'utils'
`,
      },
    ],
    invalid: [
      {
        name: 'reports named wildcard export without JSDoc',
        code: `export * as utils from 'utils'`,
        errors: [{ messageId: 'missingJsdoc', data: { name: "* from 'utils'" } }],
      },
    ],
  })
})

test('overeng/jsdoc-require-exports (type definitions)', () => {
  tsRuleTester.run('overeng/jsdoc-require-exports (type definitions)', jsdocRequireExportsRule, {
    valid: [
      {
        name: 'allows export interface with JSDoc',
        code: `
/** A user object */
export interface User {
  id: string
  name: string
}
`,
      },
      {
        name: 'allows export type alias with JSDoc',
        code: `
/** A user ID */
export type UserId = string
`,
      },
    ],
    invalid: [
      {
        name: 'reports export interface without JSDoc',
        code: `export interface User { id: string }`,
        errors: [{ messageId: 'missingJsdoc', data: { name: 'interface User' } }],
      },
      {
        name: 'reports export type alias without JSDoc',
        code: `export type UserId = string`,
        errors: [{ messageId: 'missingJsdoc', data: { name: 'type UserId' } }],
      },
    ],
  })
})

test('overeng/jsdoc-require-exports (type re-exports)', () => {
  tsRuleTester.run('overeng/jsdoc-require-exports (type re-exports)', jsdocRequireExportsRule, {
    valid: [
      {
        name: 'allows type re-export without JSDoc',
        code: `export type { MyType } from 'module'`,
      },
      {
        name: 'allows multiple type re-exports without JSDoc',
        code: `export type { Foo, Bar, Baz } from 'module'`,
      },
    ],
    invalid: [],
  })
})

test('overeng/jsdoc-require-exports (edge cases)', () => {
  ruleTester.run('overeng/jsdoc-require-exports (edge cases)', jsdocRequireExportsRule, {
    valid: [],
    invalid: [
      {
        name: 'does not accept regular comments as JSDoc',
        code: `
// This is not JSDoc
export * as utils from 'utils'
`,
        errors: [{ messageId: 'missingJsdoc' }],
      },
    ],
  })
})

test('overeng/jsdoc-require-exports (multiple type exports)', () => {
  tsRuleTester.run(
    'overeng/jsdoc-require-exports (multiple type exports)',
    jsdocRequireExportsRule,
    {
      valid: [],
      invalid: [
        {
          name: 'handles multiple type exports',
          code: `
export interface Foo {}
export type Bar = string
`,
          errors: [
            { messageId: 'missingJsdoc', data: { name: 'interface Foo' } },
            { messageId: 'missingJsdoc', data: { name: 'type Bar' } },
          ],
        },
      ],
    },
  )
})

test('overeng/jsdoc-require-exports (typeof-derived types)', () => {
  tsRuleTester.run(
    'overeng/jsdoc-require-exports (typeof-derived types)',
    jsdocRequireExportsRule,
    {
      valid: [
        {
          name: 'allows typeof-derived type without JSDoc (Effect Schema pattern)',
          code: `export type User = typeof User.Type`,
        },
        {
          name: 'allows typeof-derived type with member access chain',
          code: `export type Config = typeof import('./config').default`,
        },
        {
          name: 'allows typeof-derived type from simple identifier',
          code: `
const schema = {}
export type Schema = typeof schema
`,
        },
      ],
      invalid: [],
    },
  )
})
