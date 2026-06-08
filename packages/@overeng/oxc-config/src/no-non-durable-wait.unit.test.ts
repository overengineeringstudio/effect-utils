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

const rule = plugin.rules['no-non-durable-wait']

/** The exact rendered message for a flagged `Effect.sleep()`. */
const sleepMessage =
  'Non-durable `Effect.sleep()` schedules an in-process timer that does not survive suspension/replay. Use `Restate.sleep`/`Restate.timeout` for a durable wait, or move it inside a journaled `Restate.run(...)` step.'

ruleTester.run('no-non-durable-wait: valid durable waits', rule, {
  valid: [
    // Durable Restate waits are the intended path.
    { code: `Restate.sleep('5 seconds')` },
    { code: `Restate.timeout(action, '30 seconds')` },
    // `Effect.sleep`/`Effect.timeout` inside a journaled Restate.run step are exempt.
    { code: `Restate.run('poll', Effect.sleep('1 second'))` },
    { code: `Restate.run('with-timeout', Effect.timeout(action, '30 seconds'))` },
    // Nested deeply within the run closure is still exempt.
    {
      code: `Restate.run('x', Effect.sync(() => { const a = () => Effect.sleep('1s'); return a() }))`,
    },
    // `*.run` on a restate context (e.g. ctx.run) is the same journaled boundary.
    { code: `ctx.run('wait', () => Effect.sleep('1 second'))` },
    // Unrelated members / receivers that happen to share names.
    { code: `const x = obj.sleep('1s')` },
    { code: `const x = thing.timeout(action, '1s')` },
    // Other Effect combinators are not tracked.
    { code: `Effect.gen(function* () { yield* Effect.succeed(1) })` },
  ],
  invalid: [],
})

ruleTester.run('no-non-durable-wait: invalid non-durable wait in a handler', rule, {
  valid: [],
  invalid: [
    // Assert the exact rendered message text (RuleTester forbids combining
    // `message` and `messageId` on the same error, so use `message` alone here).
    {
      code: `const wait = Effect.sleep('5 seconds')`,
      errors: [{ message: sleepMessage }],
    },
    {
      code: `const result = Effect.timeout(action, '30 seconds')`,
      errors: [{ messageId: 'nonDurableWait' }],
    },
    // Inside a handler effect, but NOT inside a Restate.run closure.
    {
      code: `const handler = Effect.gen(function* () { yield* Effect.sleep('5 seconds') })`,
      errors: [{ messageId: 'nonDurableWait' }],
    },
    {
      code: `const handler = Effect.gen(function* () { yield* Effect.timeout(action, '30 seconds') })`,
      errors: [{ messageId: 'nonDurableWait' }],
    },
    // A non-`run` call argument does not exempt the source.
    {
      code: `Effect.sync(() => Effect.sleep('1 second'))`,
      errors: [{ messageId: 'nonDurableWait' }],
    },
  ],
})

tsRuleTester.run('no-non-durable-wait: TypeScript', rule, {
  valid: [
    {
      code: `const wait = Restate.run('poll', Effect.sleep('1 second'))`,
    },
  ],
  invalid: [
    {
      code: `const wait = Effect.sleep('5 seconds')`,
      errors: [{ messageId: 'nonDurableWait' }],
    },
  ],
})
