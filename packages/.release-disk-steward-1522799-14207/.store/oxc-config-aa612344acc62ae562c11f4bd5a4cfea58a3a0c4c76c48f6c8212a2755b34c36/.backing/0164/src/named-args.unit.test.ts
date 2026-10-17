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

const rule = plugin.rules['named-args']

ruleTester.run('named-args: valid zero or one param', rule, {
  valid: [
    { code: `const greet = () => 'hello'` },
    { code: `function greet() { return 'hello' }` },
    { code: `export const greet = () => 'hello'` },
    { code: `const greet = (name) => 'hello ' + name` },
    { code: `function greet(name) { return 'hello ' + name }` },
    { code: `export const greet = (name) => 'hello ' + name` },
    {
      code: `const createUser = ({ name, email, age }) => ({ name, email, age })`,
    },
    { code: `function createUser({ name, email }) { return { name, email } }` },
  ],
  invalid: [],
})

ruleTester.run('named-args: valid rest parameters', rule, {
  valid: [
    { code: `const log = (...args) => console.log(...args)` },
    { code: `const log = (msg, ...args) => console.log(msg, ...args)` },
    { code: `function log(msg, ...args) { console.log(msg, ...args) }` },
  ],
  invalid: [],
})

ruleTester.run('named-args: valid callbacks are exempt', rule, {
  valid: [
    { code: `items.map((item, index) => item + index)` },
    { code: `items.filter((item, index, array) => index > 0)` },
    { code: `items.reduce((acc, item, index) => acc + item, 0)` },
    { code: `items.forEach((item, index) => console.log(index, item))` },
    { code: `items.map(function(item, index) { return item + index })` },
    { code: `addEventListener('click', function(event, extra) {})` },
    { code: `createEffect((a, b) => a + b)` },
    { code: `pipe(data, (x, y) => x + y)` },
    { code: `compose((a, b, c) => a + b + c)` },
    { code: `new Promise((resolve, reject) => resolve(1))` },
    { code: `new Proxy(target, { get: (obj, prop) => obj[prop] })` },
  ],
  invalid: [],
})

ruleTester.run('named-args: valid Effect patterns', rule, {
  valid: [
    { code: `Effect.gen(function* (_) { yield* _(someEffect) })` },
    { code: `const myEffect = Effect.gen(function* (_) { return 42 })` },
    { code: `const myFn = F.dual(2, (self, name) => self + name)` },
    { code: `const myFn = F.dual(3, (self, a, b) => self + a + b)` },
    {
      code: `const myFn = F.dual(2, function(self, name) { return self + name })`,
    },
    { code: `const myFn = Function.dual(2, (self, name) => self + name)` },
    { code: `const myFn = Fn.dual(2, (self, name) => self + name)` },
    { code: `const myFn = dual(2, (self, name) => self + name)` },
  ],
  invalid: [],
})

tsRuleTester.run('named-args: valid TypeScript', rule, {
  valid: [
    { code: `const greet = (name: string): string => 'hello ' + name` },
    { code: `function greet(name: string): string { return 'hello ' + name }` },
    {
      code: `const createUser = (opts: { name: string; email: string }): User => ({ ...opts, id: 1 })`,
    },
    {
      code: `function createUser({ name, email }: UserInput): User { return { name, email, id: 1 } }`,
    },
  ],
  invalid: [],
})

ruleTester.run('named-args: invalid multiple params', rule, {
  valid: [],
  invalid: [
    {
      code: `const add = (a, b) => a + b`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `function add(a, b) { return a + b }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `const add = function(a, b) { return a + b }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `export const add = (a, b) => a + b`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `export function add(a, b) { return a + b }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `const combine = (a, b, c) => a + b + c`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `function combine(a, b, c, d) { return a + b + c + d }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `const obj = { add(a, b) { return a + b } }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `class Calculator { add(a, b) { return a + b } }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `const log = (level, msg, ...args) => console.log(level, msg, ...args)`,
      errors: [{ messageId: 'tooManyParams' }],
    },
  ],
})

tsRuleTester.run('named-args: invalid TypeScript', rule, {
  valid: [],
  invalid: [
    {
      code: `const add = (a: number, b: number): number => a + b`,
      errors: [{ messageId: 'tooManyParams' }],
    },
    {
      code: `function add(a: number, b: number): number { return a + b }`,
      errors: [{ messageId: 'tooManyParams' }],
    },
  ],
})

ruleTester.run('named-args: edge cases', rule, {
  valid: [
    {
      code: `
const outer = (x) => {
  return items.map((item, index) => item + index + x)
}
`,
    },
    {
      code: `((a, b) => a + b)(1, 2)`,
    },
  ],
  invalid: [
    {
      code: `
const outer = (x, y) => {
  return items.map((item, index) => item + index)
}
`,
      errors: [{ messageId: 'tooManyParams' }],
    },
  ],
})
