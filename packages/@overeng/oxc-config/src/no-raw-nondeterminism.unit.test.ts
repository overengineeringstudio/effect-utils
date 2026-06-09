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

const rule = plugin.rules['no-raw-nondeterminism']

/** The exact rendered message for a flagged `Date.now()`. */
const dateNowMessage =
  'Raw nondeterminism `Date.now()` breaks Restate deterministic replay. Use the journaled `Clock`/`Random` (backed by `ctx.date`/`ctx.rand`), or wrap it in `Restate.run(...)` so its result is journaled.'

ruleTester.run('no-raw-nondeterminism: valid inside Restate.run', rule, {
  valid: [
    {
      code: `const id = Restate.run('gen-id', Effect.sync(() => crypto.randomUUID()))`,
    },
    {
      code: `const now = Restate.run('now', Effect.sync(() => Date.now()))`,
    },
    {
      code: `const r = Restate.run('rand', Effect.sync(() => Math.random()))`,
    },
    {
      code: `const ts = Restate.run('ts', Effect.sync(() => new Date()))`,
    },
    {
      code: `const id = Restate.run('gen-id', Effect.sync(() => globalThis.crypto.randomUUID()))`,
    },
    // Nested deeply within the run closure is still exempt.
    {
      code: `Restate.run('x', Effect.sync(() => { const a = () => Math.random(); return a() }))`,
    },
    // `*.run` on a restate context (e.g. ctx.run) is the same journaled boundary.
    {
      code: `ctx.run('gen-id', () => crypto.randomUUID())`,
    },
  ],
  invalid: [],
})

ruleTester.run('no-raw-nondeterminism: valid journaled / deterministic sources', rule, {
  valid: [
    // Journaled Effect Clock/Random.
    { code: `Effect.gen(function* () { const now = yield* Clock.currentTimeMillis })` },
    { code: `Effect.gen(function* () { const r = yield* Random.next })` },
    // `new Date(arg)` is deterministic — only argless `new Date()` is flagged.
    { code: `const ts = new Date(1700000000000)` },
    { code: `const ts = new Date('2026-06-08')` },
    // Unrelated members that happen to share names.
    { code: `const x = obj.now()` },
    { code: `const x = obj.random()` },
    { code: `const x = thing.randomUUID()` },
  ],
  invalid: [],
})

ruleTester.run('no-raw-nondeterminism: invalid raw nondeterminism in a handler', rule, {
  valid: [],
  invalid: [
    // Assert the exact rendered message text (RuleTester forbids combining
    // `message` and `messageId` on the same error, so use `message` alone here).
    {
      code: `const now = Date.now()`,
      errors: [{ message: dateNowMessage }],
    },
    {
      code: `const r = Math.random()`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
    {
      code: `const id = crypto.randomUUID()`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
    {
      code: `const id = globalThis.crypto.randomUUID()`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
    {
      code: `const ts = new Date()`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
    // Inside a handler effect, but NOT inside a Restate.run closure.
    {
      code: `const handler = Effect.gen(function* () { const now = Date.now() })`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
    // A non-`run` call argument does not exempt the source.
    {
      code: `Effect.sync(() => Math.random())`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
  ],
})

tsRuleTester.run('no-raw-nondeterminism: TypeScript', rule, {
  valid: [
    {
      code: `const id: string = Restate.run('gen-id', Effect.sync(() => crypto.randomUUID()))`,
    },
  ],
  invalid: [
    {
      code: `const now: number = Date.now()`,
      errors: [{ messageId: 'rawNondeterminism' }],
    },
  ],
})
