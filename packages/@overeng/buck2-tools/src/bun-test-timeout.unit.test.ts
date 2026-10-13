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

test('arbitrary IEEE-754 measurements always produce a finite bounded factor', () => {
  const caps = [1, 1.5, 4, Number.MAX_VALUE]
  const extremes = [
    undefined,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    -Number.MAX_VALUE,
    -Number.MIN_VALUE,
    -1,
    -0,
    0,
    Number.MIN_VALUE,
    1,
    Number.MAX_VALUE,
  ]
  for (const load1 of extremes)
    for (const cpus of extremes)
      for (const cap of caps) {
        const factor = timeoutFactor({ load1, cpus, cap })
        expect(Number.isFinite(factor)).toBe(true)
        expect(factor).toBeGreaterThanOrEqual(1)
        expect(factor).toBeLessThanOrEqual(cap)
        if (
          load1 === undefined ||
          cpus === undefined ||
          Number.isFinite(load1) === false ||
          Number.isFinite(cpus) === false ||
          load1 <= 0 ||
          cpus <= 0
        )
          expect(factor).toBe(1)
      }
  expect(timeoutFactor({ cap: 4 })).toBe(1)
  const bits = new DataView(new ArrayBuffer(16))
  let state = 0x5eed1234
  for (let sample = 0; sample < 1000; sample += 1) {
    for (let offset = 0; offset < 16; offset += 4) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      bits.setUint32(offset, state)
    }
    for (const cap of caps) {
      const factor = timeoutFactor({ load1: bits.getFloat64(0), cpus: bits.getFloat64(8), cap })
      expect(Number.isFinite(factor)).toBe(true)
      expect(factor).toBeGreaterThanOrEqual(1)
      expect(factor).toBeLessThanOrEqual(cap)
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
