import * as testing from 'bun:test'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'

import { scaleTestTimeout } from './bun-test-timeout.ts'

const escapeTitle = (title: string): string => title.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
let scopes: readonly { readonly name: string; readonly pattern: string | undefined }[] = []

/** Match Bun's expanded titles without reimplementing its opaque pretty-printer. */
const caseTitlePattern = ({
  title,
  row,
  index,
}: {
  readonly title: string
  readonly row: unknown
  readonly index: number
}): string => {
  const values: readonly unknown[] = Array.isArray(row) === true ? row : [row]
  let argument = 0
  let cursor = 0
  let pattern = ''
  for (const token of title.matchAll(/%([psdifjo#%])|\$([\w.]+)/gu)) {
    pattern += escapeTitle(title.slice(cursor, token.index))
    cursor = token.index + token[0].length
    const specifier = token[1]
    if (specifier === '%' || specifier === '#') {
      pattern += escapeTitle(specifier === '%' ? '%' : String(index))
      continue
    }
    let value: unknown = specifier === undefined ? row : values[argument++]
    if (token[2] !== undefined)
      for (const key of token[2].split('.')) {
        const descriptor =
          typeof value === 'object' && value !== null
            ? Object.getOwnPropertyDescriptor(value, key)
            : undefined
        value = descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
      }
    if (
      (typeof value === 'object' && value !== null) ||
      typeof value === 'function' ||
      specifier === 'p' ||
      specifier === 'o' ||
      typeof value === 'symbol'
    ) {
      pattern += '[\\s\\S]*'
    } else {
      const formatted =
        specifier === 'd'
          ? String(Number(value))
          : specifier === 'i'
            ? String(Number.parseInt(String(value), 10))
            : specifier === 'f'
              ? String(Number.parseFloat(String(value)))
              : specifier === 'j' && typeof value !== 'bigint'
                ? JSON.stringify(value)
                : String(value)
      pattern += formatted === undefined ? '[\\s\\S]*' : escapeTitle(formatted)
    }
  }
  return `^${pattern}${escapeTitle(title.slice(cursor))}$`
}

/** Only registration is intercepted. JUnit owns outcomes and measured elapsed time. */
const wrap = <TFunction extends object>({
  target,
  kind,
  owner,
  cases,
}: {
  readonly target: TFunction
  readonly kind: 'test' | 'describe'
  readonly owner?: object
  readonly cases?: readonly unknown[] | undefined
}): TFunction =>
  new Proxy(target, {
    apply(callable, receiver, original: unknown[]) {
      if (typeof callable !== 'function') throw new Error('Bun registration must be callable')
      const args = [...original]
      if (typeof args[0] === 'string') {
        if (kind === 'describe' && typeof args[1] === 'function') {
          const callback = args[1]
          const name = args[0]
          // Bun can collect describe.each callbacks after the enclosing callback returns.
          const parents = scopes
          let index = 0
          const wrappedCallback = (...values: unknown[]) => {
            const previous = scopes
            const pattern =
              cases === undefined
                ? undefined
                : caseTitlePattern({ title: name, row: cases[index], index: index++ })
            scopes = [...parents, { name, pattern }]
            try {
              return Reflect.apply(callback, undefined, values)
            } finally {
              scopes = previous
            }
          }
          Object.defineProperty(wrappedCallback, 'length', { value: callback.length })
          args[1] = wrappedCallback
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
            const file = relative(process.cwd(), location[1])
            // Bun's JUnit classname orders nested suites from inner to outer.
            const reporterScopes = scopes.toReversed()
            const classname = reporterScopes.map((scope) => scope.name).join(' > ')
            const classnamePattern =
              reporterScopes.some((scope) => scope.pattern !== undefined) === true
                ? `^${reporterScopes
                    .map((scope) =>
                      scope.pattern === undefined
                        ? escapeTitle(scope.name)
                        : scope.pattern.slice(1, -1),
                    )
                    .join(' > ')}$`
                : undefined
            const records = (cases ?? [undefined]).map((row, index) => ({
              file,
              name: args[0],
              namePattern:
                cases === undefined
                  ? undefined
                  : caseTitlePattern({ title: String(args[0]), row, index }),
              classname,
              classnamePattern,
              base,
              effective,
            }))
            appendFileSync(
              metadata,
              records.map((record) => `${JSON.stringify(record)}\n`).join(''),
            )
          }
        }
      }
      const result: unknown = Reflect.apply(callable, owner ?? receiver, args)
      return typeof result === 'function'
        ? wrap({
            target: result,
            kind,
            cases: Array.isArray(args[0]) === true ? args[0] : cases,
          })
        : result
    },
    get(callable, property) {
      const value: unknown = Reflect.get(callable, property, callable)
      return typeof value === 'function'
        ? wrap({ target: value, kind, owner: callable, cases })
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
