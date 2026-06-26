import { Cause, Effect, Logger } from 'effect'
import { describe, expect, it } from 'vitest'

import { markSeamRendered, renderCliError } from './cli-program.ts'

/**
 * Run `renderCliError` with a capturing logger and return how many records it
 * emitted. `renderCliError` logs to stderr via `Effect.logError`; capturing the
 * default logger lets us assert whether a human render fired.
 */
const logCount = (cause: Cause.Cause<unknown>): number => {
  const records: unknown[] = []
  const capture = Logger.make(({ message }) => {
    records.push(message)
  })
  Effect.runSync(
    renderCliError(cause).pipe(Effect.provide(Logger.replace(Logger.defaultLogger, capture))),
  )
  return records.length
}

describe('renderCliError report-once', () => {
  it('logs an unmarked failure to stderr (the default human render)', () => {
    const error = { _tag: 'NmdGatewayError', message: 'boom' }
    expect(logCount(Cause.fail(error))).toBe(1)
  })

  it('suppresses a seam-rendered failure (already shown on stdout as CRITICAL)', () => {
    const error = { _tag: 'NmdGatewayError', message: 'boom' }
    markSeamRendered(error)
    expect(logCount(Cause.fail(error))).toBe(0)
  })

  it('marking one error does not suppress a different instance', () => {
    const shown = { _tag: 'NmdConflictError', message: 'conflict' }
    const other = { _tag: 'NmdConflictError', message: 'conflict' }
    markSeamRendered(shown)
    expect(logCount(Cause.fail(other))).toBe(1)
  })
})
