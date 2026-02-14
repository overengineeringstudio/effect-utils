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
