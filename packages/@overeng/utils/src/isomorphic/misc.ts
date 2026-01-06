import type * as otel from '@opentelemetry/api'

import { shouldNeverHappen } from './core.ts'

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export const times = ({ n, fn }: { n: number; fn: (index: number) => {} }): void => {
  for (let i = 0; i < n; i++) {
    fn(i)
  }
}

export const debugCatch = <T>(try_: () => T): T => {
  try {
    return try_()
  } catch (e: any) {
    // biome-ignore lint/suspicious/noDebugger: intentional for dev debugging
    // oxlint-disable-next-line no-debugger
    debugger
    throw e
  }
}

export const recRemoveUndefinedValues = (val: any): void => {
  if (Array.isArray(val)) {
    val.forEach(recRemoveUndefinedValues)
  } else if (typeof val === 'object') {
    Object.keys(val).forEach((key) => {
      if (val[key] === undefined) {
        delete val[key]
      } else {
        recRemoveUndefinedValues(val[key])
      }
    })
  }
}

export const prop =
  <T extends {}, K extends keyof T>(key: K) =>
  (obj: T): T[K] =>
    obj[key]

export const objectToString = (error: any): string => {
  const str = error?.toString()
  if (str !== '[object Object]') return str

  try {
    return JSON.stringify(error, null, 2)
  } catch (e: any) {
    console.log(error)

    return `Error while printing error: ${e}`
  }
}

export const errorToString = (error: any): string => {
  const stack = error.stack
  const str = error.toString()
  const stackStr = stack ? `\n${stack}` : ''
  if (str !== '[object Object]') return str + stackStr

  try {
    return JSON.stringify({ ...error, stack }, null, 2)
  } catch (e: any) {
    console.log(error)

    return `Error while printing error: ${e}`
  }
}

export const capitalizeFirstLetter = (str: string): string =>
  str.charAt(0).toUpperCase() + str.slice(1)

/**
 * Use this to make assertion at end of if-else chain that all members of a
 * union have been accounted for.
 */
// oxlint-disable-next-line func-style
export function casesHandled(unexpectedCase: never): never {
  // biome-ignore lint/suspicious/noDebugger: intentional for dev debugging
  // oxlint-disable-next-line no-debugger
  debugger
  throw new Error(
    `A case was not handled for value: ${truncate({ str: objectToString(unexpectedCase), length: 1000 })}`,
  )
}

export const assertNever = ({
  condition,
  msg,
}: {
  condition: boolean
  msg?: string | (() => string)
}): void => {
  if (condition === false) {
    const msg_ = typeof msg === 'function' ? msg() : msg
    // biome-ignore lint/suspicious/noDebugger: intentional for dev debugging
    // oxlint-disable-next-line no-debugger
    debugger
    throw new Error(`This should never happen ${msg_}`)
  }
}

export const debuggerPipe = <T>(val: T): T => {
  // biome-ignore lint/suspicious/noDebugger: intentional for dev debugging
  // oxlint-disable-next-line no-debugger
  debugger
  return val
}

/** Sometimes useful when type definitions say a type is non-null/non-undefined but in during runtime it might be null/undefined */
export const asNilish = <T>(val: T): T | null | undefined => val

export const truncate = ({ str, length }: { str: string; length: number }): string => {
  if (str.length > length) {
    return `${str.slice(0, length)}...`
  } else {
    return str
  }
}

export const notYetImplemented = (msg?: string): never => {
  // biome-ignore lint/suspicious/noDebugger: intentional for dev debugging
  // oxlint-disable-next-line no-debugger
  debugger
  throw new Error(`Not yet implemented ${msg}`)
}

export const noop = () => {}

/** A lazy value - a function that returns T when called */
export type Thunk<T> = () => T

export const unwrapThunk = <T>(_: T | (() => T)): T => {
  if (typeof _ === 'function') {
    return (_ as any)()
  } else {
    return _
  }
}

/** `end` is not included */
export const range = ({ start, end }: { start: number; end: number }): number[] => {
  const length = end - start
  return Array.from({ length }, (_, i) => start + i)
}

export const throttle = ({ fn, ms }: { fn: () => void; ms: number }) => {
  let shouldWait = false
  let shouldCallAgain = false

  const timeoutFunc = () => {
    if (shouldCallAgain) {
      fn()
      shouldCallAgain = false
      setTimeout(timeoutFunc, ms)
    } else {
      shouldWait = false
    }
  }

  return () => {
    if (shouldWait) {
      shouldCallAgain = true
      return
    }

    fn()
    shouldWait = true
    setTimeout(timeoutFunc, ms)
  }
}

export const getTraceParentHeader = (parentSpan: otel.Span) => {
  const spanContext = parentSpan.spanContext()
  // Format: {version}-{trace_id}-{span_id}-{trace_flags}
  // https://www.w3.org/TR/trace-context/#examples-of-http-traceparent-headers
  return `00-${spanContext.traceId}-${spanContext.spanId}-01`
}

export const assertTag = <TObj extends { _tag: string }, TTag extends TObj['_tag']>({
  obj,
  tag,
}: {
  obj: TObj
  tag: TTag
}): Extract<TObj, { _tag: TTag }> => {
  if (obj._tag !== tag) {
    return shouldNeverHappen(`Expected tag ${tag} but got ${obj._tag}`)
  }

  return obj as any
}

export const memoize = <T extends (...args: any[]) => any>(fn: T): T => {
  const cache = new Map<string, ReturnType<T>>()

  return ((...args: any[]) => {
    const key = JSON.stringify(args)
    if (cache.has(key)) {
      return cache.get(key)
    }

    const result = fn(...args)
    cache.set(key, result)
    return result
  }) as any
}

export const isNonEmptyString = (str: string | undefined | null): str is string => {
  return typeof str === 'string' && str.length > 0
}

// oxlint-disable-next-line overeng/named-args -- debug utility
export const __debugPassthroughLog = <T>(val: T, key = ''): T => {
  console.log(key, val)
  return val
}
