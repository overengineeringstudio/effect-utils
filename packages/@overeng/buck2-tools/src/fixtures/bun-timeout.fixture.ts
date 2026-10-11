import { describe, expect, test } from 'bun:test'

describe('classification fixture', () => {
  test('deliberate timeout', () => Promise.withResolvers<void>().promise, 20)
  test('deliberate assertion', () => expect('actual & <value>').toBe('expected'))
  test.each([1, 2])('parameterized timeout %s', () => Promise.withResolvers<void>().promise, {
    timeout: 10,
  })
  test.skip('skipped timeout', () => Promise.withResolvers<void>().promise, 10)
})
