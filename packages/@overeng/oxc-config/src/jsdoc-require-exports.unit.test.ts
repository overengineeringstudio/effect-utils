import tsParser from '@typescript-eslint/parser'
import { RuleTester } from '@typescript-eslint/rule-tester'
import { afterAll, describe, it } from 'vitest'

import { jsdocRequireExportsRule } from './jsdoc-require-exports.ts'

RuleTester.afterAll = afterAll
RuleTester.describe = describe
RuleTester.it = it

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    parser: tsParser,
  },
})

ruleTester.run('jsdoc-require-exports: value exports', jsdocRequireExportsRule, {
  valid: [
    {
      name: 'allows exported const with JSDoc',
      code: `
/** Does something useful */
export const publicApi = () => {}
`,
    },
    {
      name: 'allows exported function with JSDoc',
      code: `
/** Does something */
export function doSomething() {}
`,
    },
    {
      name: 'allows exported class with JSDoc',
      code: `
/** A useful class */
export class MyClass {}
`,
    },
    {
      name: 'allows export default without JSDoc (not checked)',
      code: `export default function main() {}`,
    },
    {
      name: 'allows named re-exports without JSDoc (source has docs)',
      code: `export { something } from 'module'`,
    },
  ],
  invalid: [
    {
      name: 'reports exported const without JSDoc',
      code: `export const publicApi = () => {}`,
      errors: [{ messageId: 'missingJsdoc', data: { name: 'const publicApi' } }],
    },
    {
      name: 'reports exported function without JSDoc',
      code: `export function doSomething() {}`,
      errors: [{ messageId: 'missingJsdoc', data: { name: 'function doSomething' } }],
    },
    {
      name: 'reports exported class without JSDoc',
      code: `export class MyClass {}`,
      errors: [{ messageId: 'missingJsdoc', data: { name: 'class MyClass' } }],
    },
  ],
})

ruleTester.run('jsdoc-require-exports: wildcard exports', jsdocRequireExportsRule, {
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

ruleTester.run('jsdoc-require-exports: type definitions', jsdocRequireExportsRule, {
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

ruleTester.run('jsdoc-require-exports: type re-exports', jsdocRequireExportsRule, {
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

ruleTester.run('jsdoc-require-exports: JSDoc adjacency', jsdocRequireExportsRule, {
  valid: [
    {
      name: 'allows adjacent JSDoc (immediately before)',
      code: `
/** Foo type */
export type Foo = string
`,
    },
  ],
  invalid: [
    {
      name: 'reports when module-level comment is not adjacent (blank line between)',
      code: `
/**
 * This is a module-level doc comment.
 */

export type Foo = string
`,
      errors: [{ messageId: 'missingJsdoc', data: { name: 'type Foo' } }],
    },
    {
      name: 'reports when module-level comment is followed by first export without own doc',
      code: `
/**
 * Module description.
 */

export type Foo = string

/** Bar has docs */
export type Bar = number

export type Baz = boolean
`,
      errors: [
        { messageId: 'missingJsdoc', data: { name: 'type Foo' } },
        { messageId: 'missingJsdoc', data: { name: 'type Baz' } },
      ],
    },
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

ruleTester.run('jsdoc-require-exports: multiple exports', jsdocRequireExportsRule, {
  valid: [],
  invalid: [
    {
      name: 'reports each missing JSDoc for types',
      code: `
export interface Foo {}
export type Bar = string
`,
      errors: [
        { messageId: 'missingJsdoc', data: { name: 'interface Foo' } },
        { messageId: 'missingJsdoc', data: { name: 'type Bar' } },
      ],
    },
    {
      name: 'reports each missing JSDoc for values',
      code: `
export const foo = 1
export function bar() {}
`,
      errors: [
        { messageId: 'missingJsdoc', data: { name: 'const foo' } },
        { messageId: 'missingJsdoc', data: { name: 'function bar' } },
      ],
    },
  ],
})

ruleTester.run('jsdoc-require-exports: typeof-derived types', jsdocRequireExportsRule, {
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
})

ruleTester.run(
  'jsdoc-require-exports: JSDoc with intervening line comments',
  jsdocRequireExportsRule,
  {
    valid: [
      {
        name: 'allows JSDoc with single line comment in between',
        code: `
/** Does something useful */
// oxlint-disable-next-line some-rule
export const foo = () => {}
`,
      },
      {
        name: 'allows JSDoc with multiple line comments in between',
        code: `
/** Does something useful */
// some comment
// oxlint-disable-next-line
export const foo = () => {}
`,
      },
      {
        name: 'allows JSDoc with line comment for types',
        code: `
/** User type */
// oxlint-disable-next-line some-rule
export type User = { id: string }
`,
      },
      {
        name: 'allows JSDoc with line comment for interfaces',
        code: `
/** Config interface */
// some-other-comment
export interface Config { value: string }
`,
      },
    ],
    invalid: [
      {
        name: 'reports when blank line separates JSDoc from export (even with line comment after blank)',
        code: `
/** This is too far away */

// This line comment comes after the blank
export const foo = () => {}
`,
        errors: [{ messageId: 'missingJsdoc', data: { name: 'const foo' } }],
      },
      {
        name: 'reports when only line comment exists (no JSDoc)',
        code: `
// This is not JSDoc
export const foo = () => {}
`,
        errors: [{ messageId: 'missingJsdoc', data: { name: 'const foo' } }],
      },
    ],
  },
)
