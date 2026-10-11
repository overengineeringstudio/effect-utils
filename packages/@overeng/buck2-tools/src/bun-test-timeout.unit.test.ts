import { expect, test } from 'bun:test'

import { configuredTimeoutFactor, timeoutFactor } from './bun-test-timeout.ts'

test('timeout factor is monotonic in load and bounded between one and the cap', () => {
  for (const cpus of [1, 2, 8, 20, 64, 256]) {
    for (const cap of [1, 1.5, 2, 4, 10]) {
      let previous = 1
      for (let step = 0; step <= 200; step += 1) {
        const factor = timeoutFactor({ load1: (step * cpus) / 10, cpus, cap })
        expect(factor).toBeGreaterThanOrEqual(previous)
        expect(factor).toBeGreaterThanOrEqual(1)
        expect(factor).toBeLessThanOrEqual(cap)
        previous = factor
      }
    }
  }
})

test('default cap is four, a cap is configurable, and scaling can be disabled', () => {
  const host = { load1: 100, cpus: 2, memPsiFullAvg10: undefined }
  expect(configuredTimeoutFactor({ host, env: {} })).toBe(4)
  expect(configuredTimeoutFactor({ host, env: { BUN_TEST_TIMEOUT_CAP: '2' } })).toBe(2)
  expect(configuredTimeoutFactor({ host, env: { BUN_TEST_TIMEOUT_SCALING: '0' } })).toBe(1)
  for (const cap of ['0', '-1', 'NaN', 'Infinity', ''])
    expect(() => configuredTimeoutFactor({ host, env: { BUN_TEST_TIMEOUT_CAP: cap } })).toThrow()
})
