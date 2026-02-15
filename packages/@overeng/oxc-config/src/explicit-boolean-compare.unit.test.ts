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

const rule = plugin.rules['explicit-boolean-compare']

// ---------------------------------------------------------------------------
// Valid: explicit comparisons in if statements
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: valid if comparisons', rule, {
  valid: [
    { code: `if (x === true) {}` },
    { code: `if (x === false) {}` },
    { code: `if (x !== true) {}` },
    { code: `if (x !== false) {}` },
    { code: `if (x > 0) {}` },
    { code: `if (x < 10) {}` },
    { code: `if (x >= 0) {}` },
    { code: `if (x <= 100) {}` },
    { code: `if (x === 'hello') {}` },
    { code: `if (x !== null) {}` },
    { code: `if (x !== undefined) {}` },
    { code: `if (x == null) {}` },
    { code: `if (x != null) {}` },
    { code: `if (x instanceof Error) {}` },
    { code: `if ('key' in obj) {}` },
    { code: `if (true) {}` },
    { code: `if (false) {}` },
  ],
  invalid: [],
})

// ---------------------------------------------------------------------------
// Valid: explicit comparisons with logical operators
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: valid logical combinations', rule, {
  valid: [
    { code: `if (x === true && y === false) {}` },
    { code: `if (x > 0 || y < 10) {}` },
    { code: `if (x === true && y > 0 && z !== null) {}` },
    { code: `if (x instanceof Error || y === false) {}` },
    { code: `if (!(x > 0)) {}` },
    { code: `if (!(x === true)) {}` },
  ],
  invalid: [],
})

// ---------------------------------------------------------------------------
// Valid: explicit comparisons in while, do-while, for, ternary
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: valid other condition positions', rule, {
  valid: [
    { code: `while (x === true) {}` },
    { code: `do {} while (x === false)` },
    { code: `for (let i = 0; i < 10; i++) {}` },
    { code: `const result = x === true ? 'yes' : 'no'` },
    // for-statement with no test is fine
    { code: `for (;;) {}` },
  ],
  invalid: [],
})

// ---------------------------------------------------------------------------
// Valid: import.meta.main is allowed implicitly
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: import.meta.main allowed', rule, {
  valid: [{ code: `if (import.meta.main) {}` }, { code: `if (import.meta.main && x === true) {}` }],
  invalid: [],
})

// ---------------------------------------------------------------------------
// Valid: non-condition positions are not checked
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: non-condition positions ignored', rule, {
  valid: [
    { code: `const x = isReady` },
    { code: `const x = isReady && isEnabled` },
    { code: `const x = !isReady` },
    { code: `console.log(isReady)` },
    { code: `function f() { return isReady }` },
    { code: `[1, 2, 3].filter(x => x)` },
  ],
  invalid: [],
})

// ---------------------------------------------------------------------------
// Invalid: implicit boolean in if statements
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: invalid if implicit', rule, {
  valid: [],
  invalid: [
    {
      code: `if (isReady) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `if (!isReady) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `if (getValue()) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `if (obj.isReady) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `if (!obj.isReady) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
  ],
})

// ---------------------------------------------------------------------------
// Invalid: implicit boolean in logical expressions within conditions
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: invalid logical with implicit operands', rule, {
  valid: [],
  invalid: [
    {
      name: 'both operands implicit',
      code: `if (a && b) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
    {
      name: 'only right operand implicit',
      code: `if (a === true && b) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'only left operand implicit',
      code: `if (a && b === false) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'nested logical with implicit operands',
      code: `if (a || b && c) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
    {
      name: 'negation with implicit logical operands',
      code: `if (!(a && b)) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
  ],
})

// ---------------------------------------------------------------------------
// Invalid: implicit boolean in while, do-while, for, ternary
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: invalid other condition positions', rule, {
  valid: [],
  invalid: [
    {
      code: `while (running) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `while (!done) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `do {} while (active)`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `for (let i = 0; flag; i++) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `for (let i = 0; !flag; i++) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `const result = isReady ? 'yes' : 'no'`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
  ],
})

// ---------------------------------------------------------------------------
// Auto-fix: known boolean-returning call expressions
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: auto-fix known boolean calls', rule, {
  valid: [],
  invalid: [
    // Known boolean methods — positive
    {
      name: '.includes() → === true',
      code: `if (arr.includes(x)) {}`,
      output: `if (arr.includes(x) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '.startsWith() → === true',
      code: `if (str.startsWith('a')) {}`,
      output: `if (str.startsWith('a') === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '.endsWith() → === true',
      code: `if (str.endsWith('.js')) {}`,
      output: `if (str.endsWith('.js') === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '.test() → === true',
      code: `if (re.test(str)) {}`,
      output: `if (re.test(str) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '.has() → === true',
      code: `if (map.has(key)) {}`,
      output: `if (map.has(key) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '.every() → === true',
      code: `if (arr.every(fn)) {}`,
      output: `if (arr.every(fn) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '.some() → === true',
      code: `if (arr.some(fn)) {}`,
      output: `if (arr.some(fn) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    // Known boolean methods — negated
    {
      name: '!.includes() → === false',
      code: `if (!arr.includes(x)) {}`,
      output: `if (arr.includes(x) === false) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '!.test() → === false',
      code: `if (!re.test(str)) {}`,
      output: `if (re.test(str) === false) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    // is*/has* naming convention — member expression
    {
      name: 'Option.isSome() → === true',
      code: `if (Option.isSome(x)) {}`,
      output: `if (Option.isSome(x) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '!Option.isSome() → === false',
      code: `if (!Option.isSome(x)) {}`,
      output: `if (Option.isSome(x) === false) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'Either.isLeft() → === true',
      code: `if (Either.isLeft(x)) {}`,
      output: `if (Either.isLeft(x) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'Array.isArray() → === true',
      code: `if (Array.isArray(x)) {}`,
      output: `if (Array.isArray(x) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    // is*/has* naming convention — standalone function
    {
      name: 'isSomething() → === true',
      code: `if (isSomething()) {}`,
      output: `if (isSomething() === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: '!isSomething() → === false',
      code: `if (!isSomething()) {}`,
      output: `if (isSomething() === false) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'hasPermission() → === true',
      code: `if (hasPermission()) {}`,
      output: `if (hasPermission() === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    // Chained member expression
    {
      name: 'this.arr.includes() → === true',
      code: `if (this.arr.includes(x)) {}`,
      output: `if (this.arr.includes(x) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    // Other condition positions
    {
      name: 'while with known boolean call',
      code: `while (arr.includes(x)) {}`,
      output: `while (arr.includes(x) === true) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'do-while with known boolean call',
      code: `do {} while (arr.includes(x))`,
      output: `do {} while (arr.includes(x) === true)`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'ternary with known boolean call',
      code: `const r = arr.includes(x) ? 'yes' : 'no'`,
      output: `const r = arr.includes(x) === true ? 'yes' : 'no'`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      name: 'for with known boolean call',
      code: `for (let i = 0; arr.includes(i); i++) {}`,
      output: `for (let i = 0; arr.includes(i) === true; i++) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
  ],
})

// ---------------------------------------------------------------------------
// Auto-fix: mixed fixable and non-fixable in logical expressions
// ---------------------------------------------------------------------------

ruleTester.run('explicit-boolean-compare: auto-fix in logical expressions', rule, {
  valid: [],
  invalid: [
    {
      name: 'fixable left, non-fixable right',
      code: `if (arr.includes(x) && b) {}`,
      output: `if (arr.includes(x) === true && b) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
    {
      name: 'non-fixable left, fixable right',
      code: `if (a && arr.includes(x)) {}`,
      output: `if (a && arr.includes(x) === true) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
    {
      name: 'both fixable',
      code: `if (arr.includes(x) && Option.isSome(y)) {}`,
      output: `if (arr.includes(x) === true && Option.isSome(y) === true) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
    {
      name: 'fixable with negation in logical',
      code: `if (!arr.includes(x) || isSomething()) {}`,
      output: `if (arr.includes(x) === false || isSomething() === true) {}`,
      errors: [
        { messageId: 'implicitBooleanCondition' },
        { messageId: 'implicitBooleanCondition' },
      ],
    },
  ],
})

// ---------------------------------------------------------------------------
// TypeScript-specific cases
// ---------------------------------------------------------------------------

tsRuleTester.run('explicit-boolean-compare: TypeScript patterns', rule, {
  valid: [
    { code: `if (value === true) {}` },
    { code: `if (arr.length > 0) {}` },
    { code: `if (typeof x === 'string') {}` },
  ],
  invalid: [
    {
      code: `if (value as boolean) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
    {
      code: `if (obj?.isReady) {}`,
      errors: [{ messageId: 'implicitBooleanCondition' }],
    },
  ],
})
