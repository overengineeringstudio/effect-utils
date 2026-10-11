import * as testing from 'bun:test'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'

import { scaleTestTimeout } from './bun-test-timeout.ts'

const scopes: string[] = []

/** Only registration is intercepted. JUnit owns outcomes and measured elapsed time. */
const wrap = <TFunction extends object>({
  target,
  kind,
  owner,
  repetitions = 1,
}: {
  readonly target: TFunction
  readonly kind: 'test' | 'describe'
  readonly owner?: object
  readonly repetitions?: number
}): TFunction =>
  new Proxy(target, {
    apply(callable, receiver, original: unknown[]) {
      if (typeof callable !== 'function') throw new Error('Bun registration must be callable')
      const args = [...original]
      if (typeof args[0] === 'string') {
        if (kind === 'describe' && typeof args[1] === 'function') {
          const callback = args[1]
          const name = args[0]
          args[1] = (...values: unknown[]) => {
            scopes.push(name)
            try {
              return Reflect.apply(callback, undefined, values)
            } finally {
              scopes.pop()
            }
          }
        } else if (kind === 'test') {
          const options = args[2]
          const base =
            typeof options === 'number'
              ? options
              : typeof options === 'object' &&
                  options !== null &&
                  'timeout' in options &&
                  typeof options.timeout === 'number'
                ? options.timeout
                : Number(process.env['BUN_TEST_TIMEOUT_BASE'] ?? 5000)
          const effective = scaleTestTimeout(base)
          args[2] =
            typeof options === 'object' && options !== null
              ? { ...options, timeout: effective }
              : effective
          const frame = new Error().stack
            ?.split('\n')
            .find(
              (line) =>
                line.includes(import.meta.path) === false && /:\d+(?::\d+)?\)?$/u.test(line),
            )
          const location = /(?:\(|at )(\/.*?):(\d+)(?::\d+)?\)?$/u.exec(frame ?? '')
          const metadata = process.env['BUN_TEST_TIMEOUT_METADATA']
          if (metadata !== undefined && location?.[1] !== undefined) {
            const record = `${JSON.stringify({
              file: relative(process.cwd(), location[1]),
              name: args[0],
              classname: scopes.join(' > '),
              base,
              effective,
            })}\n`
            appendFileSync(metadata, record.repeat(repetitions))
          }
        }
      }
      const result: unknown = Reflect.apply(callable, owner ?? receiver, args)
      return typeof result === 'function'
        ? wrap({
            target: result,
            kind,
            repetitions: Array.isArray(args[0]) === true ? args[0].length : repetitions,
          })
        : result
    },
    get(callable, property) {
      const value: unknown = Reflect.get(callable, property, callable)
      return typeof value === 'function'
        ? wrap({ target: value, kind, owner: callable, repetitions })
        : value
    },
  })

// Native each/skip/only/concurrent registration APIs retain their receiver and callbacks.
testing.mock.module('bun:test', () => ({
  ...testing,
  describe: wrap({ target: testing.describe, kind: 'describe' }),
  test: wrap({ target: testing.test, kind: 'test' }),
  it: wrap({ target: testing.it, kind: 'test' }),
}))
