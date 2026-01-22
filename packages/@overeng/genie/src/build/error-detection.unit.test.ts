import { describe, expect, it } from 'vitest'

import { errorOriginatesInFile, isTdzError } from './generation.ts'

describe('isTdzError', () => {
  it('returns true for TDZ ReferenceError', () => {
    const error = new ReferenceError("Cannot access 'catalog' before initialization")
    expect(isTdzError(error)).toBe(true)
  })

  it('returns true for TDZ error with different variable name', () => {
    const error = new ReferenceError("Cannot access 'config' before initialization")
    expect(isTdzError(error)).toBe(true)
  })

  it('returns false for regular ReferenceError', () => {
    const error = new ReferenceError('foo is not defined')
    expect(isTdzError(error)).toBe(false)
  })

  it('returns false for TypeError', () => {
    const error = new TypeError('Cannot read property of undefined')
    expect(isTdzError(error)).toBe(false)
  })

  it('returns false for regular Error', () => {
    const error = new Error('Some error')
    expect(isTdzError(error)).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isTdzError('string')).toBe(false)
    expect(isTdzError(null)).toBe(false)
    expect(isTdzError(undefined)).toBe(false)
    expect(isTdzError({})).toBe(false)
  })
})

describe('errorOriginatesInFile', () => {
  it('returns false for TDZ errors (they never originate in the file)', () => {
    const error = new ReferenceError("Cannot access 'catalog' before initialization")
    // Even with a matching stack trace, TDZ errors don't originate in the file
    error.stack = `ReferenceError: Cannot access 'catalog' before initialization
    at /path/to/file.ts:10:5`
    expect(errorOriginatesInFile({ error, filePath: '/path/to/file.ts' })).toBe(false)
  })

  it('returns true when error stack contains the file path', () => {
    const error = new Error('Some initialization error')
    error.stack = `Error: Some initialization error
    at Object.<anonymous> (/path/to/internal.ts:5:9)
    at Module._compile (node:internal/modules/cjs/loader:1358:14)`
    expect(errorOriginatesInFile({ error, filePath: '/path/to/internal.ts' })).toBe(true)
  })

  it('returns false when error stack does not contain the file path', () => {
    const error = new Error('Propagated error from dependency')
    error.stack = `Error: Propagated error from dependency
    at Object.<anonymous> (/path/to/internal.ts:5:9)
    at Module._compile (node:internal/modules/cjs/loader:1358:14)`
    expect(errorOriginatesInFile({ error, filePath: '/path/to/consumer.ts' })).toBe(false)
  })

  it('returns false when error has no stack trace', () => {
    const error = new Error('Error without stack')
    delete error.stack
    expect(errorOriginatesInFile({ error, filePath: '/path/to/file.ts' })).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(errorOriginatesInFile({ error: 'string error', filePath: '/path/to/file.ts' })).toBe(
      false,
    )
    expect(errorOriginatesInFile({ error: null, filePath: '/path/to/file.ts' })).toBe(false)
    expect(errorOriginatesInFile({ error: undefined, filePath: '/path/to/file.ts' })).toBe(false)
  })

  it('handles partial file path matches correctly', () => {
    const error = new Error('Error in file')
    error.stack = `Error: Error in file
    at Object.<anonymous> (/path/to/file.ts:5:9)`

    // Full path match - should return true
    expect(errorOriginatesInFile({ error, filePath: '/path/to/file.ts' })).toBe(true)

    // Partial path that exists in stack - should return true (substring match)
    expect(errorOriginatesInFile({ error, filePath: 'file.ts' })).toBe(true)

    // Path not in stack - should return false
    expect(errorOriginatesInFile({ error, filePath: '/other/path.ts' })).toBe(false)
  })
})
