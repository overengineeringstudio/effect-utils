import { RuleTester } from 'eslint'
import tseslint from 'typescript-eslint'
import { describe, it } from 'vitest'

import plugin from './mod.ts'

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

const rule = plugin.rules['named-args']

describe('overeng/named-args', () => {
  describe('valid cases - zero or one param', () => {
    it('allows functions with no parameters', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `const greet = () => 'hello'` },
          { code: `function greet() { return 'hello' }` },
          { code: `export const greet = () => 'hello'` },
        ],
        invalid: [],
      })
    })

    it('allows functions with one parameter', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `const greet = (name) => 'hello ' + name` },
          { code: `function greet(name) { return 'hello ' + name }` },
          { code: `export const greet = (name) => 'hello ' + name` },
        ],
        invalid: [],
      })
    })

    it('allows functions with destructured options object', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `const createUser = ({ name, email, age }) => ({ name, email, age })` },
          { code: `function createUser({ name, email }) { return { name, email } }` },
        ],
        invalid: [],
      })
    })
  })

  describe('valid cases - rest parameters', () => {
    it('allows rest parameters only', () => {
      ruleTester.run('named-args', rule, {
        valid: [{ code: `const log = (...args) => console.log(...args)` }],
        invalid: [],
      })
    })

    it('allows one param plus rest parameters', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `const log = (msg, ...args) => console.log(msg, ...args)` },
          { code: `function log(msg, ...args) { console.log(msg, ...args) }` },
        ],
        invalid: [],
      })
    })
  })

  describe('valid cases - callbacks are exempt', () => {
    it('allows multi-param arrow functions passed to array methods', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `items.map((item, index) => item + index)` },
          { code: `items.filter((item, index, array) => index > 0)` },
          { code: `items.reduce((acc, item, index) => acc + item, 0)` },
          { code: `items.forEach((item, index) => console.log(index, item))` },
        ],
        invalid: [],
      })
    })

    it('allows multi-param function expressions passed as arguments', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `items.map(function(item, index) { return item + index })` },
          { code: `addEventListener('click', function(event, extra) {})` },
        ],
        invalid: [],
      })
    })

    it('allows callbacks in generic function calls', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `createEffect((a, b) => a + b)` },
          { code: `pipe(data, (x, y) => x + y)` },
          { code: `compose((a, b, c) => a + b + c)` },
        ],
        invalid: [],
      })
    })

    it('allows callbacks in new expressions', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `new Promise((resolve, reject) => resolve(1))` },
          { code: `new Proxy(target, { get: (obj, prop) => obj[prop] })` },
        ],
        invalid: [],
      })
    })
  })

  describe('valid cases - Effect patterns', () => {
    it('allows Effect.gen with adapter parameter', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `Effect.gen(function* (_) { yield* _(someEffect) })` },
          { code: `const myEffect = Effect.gen(function* (_) { return 42 })` },
        ],
        invalid: [],
      })
    })

    it('allows Effect dual functions with F.dual', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `const myFn = F.dual(2, (self, name) => self + name)` },
          { code: `const myFn = F.dual(3, (self, a, b) => self + a + b)` },
          { code: `const myFn = F.dual(2, function(self, name) { return self + name })` },
        ],
        invalid: [],
      })
    })

    it('allows Effect dual functions with Function.dual', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          { code: `const myFn = Function.dual(2, (self, name) => self + name)` },
          { code: `const myFn = Fn.dual(2, (self, name) => self + name)` },
        ],
        invalid: [],
      })
    })

    it('allows Effect dual functions with imported dual', () => {
      ruleTester.run('named-args', rule, {
        valid: [{ code: `const myFn = dual(2, (self, name) => self + name)` }],
        invalid: [],
      })
    })
  })

  describe('valid cases - TypeScript', () => {
    it('allows typed single parameter', () => {
      tsRuleTester.run('named-args', rule, {
        valid: [
          { code: `const greet = (name: string): string => 'hello ' + name` },
          { code: `function greet(name: string): string { return 'hello ' + name }` },
        ],
        invalid: [],
      })
    })

    it('allows typed options object', () => {
      tsRuleTester.run('named-args', rule, {
        valid: [
          {
            code: `const createUser = (opts: { name: string; email: string }): User => ({ ...opts, id: 1 })`,
          },
          {
            code: `function createUser({ name, email }: UserInput): User { return { name, email, id: 1 } }`,
          },
        ],
        invalid: [],
      })
    })
  })

  describe('invalid cases - multiple params on user-defined functions', () => {
    it('reports arrow function with two params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `const add = (a, b) => a + b`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports function declaration with two params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `function add(a, b) { return a + b }`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports function expression with two params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `const add = function(a, b) { return a + b }`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports exported function with multiple params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `export const add = (a, b) => a + b`,
            errors: [{ messageId: 'tooManyParams' }],
          },
          {
            code: `export function add(a, b) { return a + b }`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports function with three or more params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `const combine = (a, b, c) => a + b + c`,
            errors: [{ messageId: 'tooManyParams' }],
          },
          {
            code: `function combine(a, b, c, d) { return a + b + c + d }`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports method definitions with multiple params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `const obj = { add(a, b) { return a + b } }`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports class methods with multiple params', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `class Calculator { add(a, b) { return a + b } }`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })

    it('reports two params plus rest (rest does not exempt extra non-rest params)', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
        invalid: [
          {
            code: `const log = (level, msg, ...args) => console.log(level, msg, ...args)`,
            errors: [{ messageId: 'tooManyParams' }],
          },
        ],
      })
    })
  })

  describe('invalid cases - TypeScript', () => {
    it('reports typed function with multiple params', () => {
      tsRuleTester.run('named-args', rule, {
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
    })
  })

  describe('edge cases', () => {
    it('does not report nested callbacks even with multiple params', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          {
            code: `
const outer = (x) => {
  return items.map((item, index) => item + index + x)
}
`,
          },
        ],
        invalid: [],
      })
    })

    it('reports outer function but not inner callback', () => {
      ruleTester.run('named-args', rule, {
        valid: [],
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
    })

    it('allows IIFE callbacks with multiple params', () => {
      ruleTester.run('named-args', rule, {
        valid: [
          {
            code: `((a, b) => a + b)(1, 2)`,
          },
        ],
        invalid: [],
      })
    })
  })
})
