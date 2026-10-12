import { describe, expect, test } from 'bun:test'

describe('classification fixture', () => {
  test('deliberate timeout', () => Promise.withResolvers<void>().promise, 20)
  test('deliberate assertion', () => expect('actual & <value>').toBe('expected'))
  test.each(['alpha', 'beta'])(
    'parameterized timeout %s',
    (_case) => Promise.withResolvers<void>().promise,
    {
      timeout: 10,
    },
  )
  test.each([{ name: 'first' }, { name: 'second' }])(
    'object case $name',
    (_case) => Promise.withResolvers<void>().promise,
    13,
  )
  describe.each([
    { label: 'short', deadline: 7 },
    { label: 'long', deadline: 11 },
  ])('scope $label', (row) => {
    test('scoped timeout', () => Promise.withResolvers<void>().promise, row.deadline)
  })
  test.each(['excluded'])(
    'filtered timeout %s',
    (_case) => Promise.withResolvers<void>().promise,
    23,
  )
  test.each(['selected'])(
    'filtered timeout %s',
    (_case) => Promise.withResolvers<void>().promise,
    29,
  )
  test.skip('skipped timeout', () => Promise.withResolvers<void>().promise, 10)
})
