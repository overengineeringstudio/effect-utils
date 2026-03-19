import * as fs from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'

import { clearFormat } from './clear-format.ts'
import { format } from './format.ts'
import { parse } from './parse.ts'

const fixturesDir = path.join(import.meta.dirname, '..', 'test-fixtures')
const inputDir = path.join(fixturesDir, 'input')
const expectedDir = path.join(fixturesDir, 'expected_kdl')

const inputFiles = fs
  .readdirSync(inputDir)
  .filter((f) => f.endsWith('.kdl'))
  .sort()

/** JS Number precision limitations — values exceed MAX_SAFE_INTEGER or require BigDecimal */
const knownBrokenTests = new Set(['hex', 'hex_int', 'sci_notation_large', 'sci_notation_small'])

describe('KDL upstream test suite', () => {
  for (const file of inputFiles) {
    const name = file.replace(/\.kdl$/, '')
    const isFail = name.includes('_fail')
    const inputPath = path.join(inputDir, file)
    const testFn = knownBrokenTests.has(name) ? it.skip : it

    if (isFail) {
      it(`${name} (should fail to parse)`, () => {
        const input = fs.readFileSync(inputPath, 'utf-8')
        expect(() => parse(input)).toThrow()
      })
    } else {
      testFn(name, () => {
        const input = fs.readFileSync(inputPath, 'utf-8')
        const expectedPath = path.join(expectedDir, file)
        const expected = fs.readFileSync(expectedPath, 'utf-8')

        const doc = parse(input)
        clearFormat(doc)
        const output = format(doc)

        expect(output).toBe(expected)
      })
    }
  }
})
