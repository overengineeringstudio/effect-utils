import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { normalizeTestReport, publishTestVerdict, readTestVerdict } from './test-verdict.ts'

const report = {
  success: true,
  testResults: [
    {
      name: '/tree/src/b.unit.test.ts',
      assertionResults: [{ fullName: 'b', status: 'passed', failureMessages: [] }],
    },
    {
      name: '/tree/src/a.unit.test.ts',
      assertionResults: [{ fullName: 'a', status: 'passed', failureMessages: [] }],
    },
  ],
}

describe('unit test verdict artifacts', () => {
  it('normalizes paths and rejects status disagreements', () => {
    expect(normalizeTestReport({ raw: report, packageTree: '/tree', status: 0 })).toMatchObject({
      verdict: 'pass',
      suites: [{ file: 'src/a.unit.test.ts' }, { file: 'src/b.unit.test.ts' }],
    })
    expect(() =>
      normalizeTestReport({
        raw: { ...report, success: false },
        packageTree: '/tree',
        status: 0,
      }),
    ).toThrow('disagree')
  })

  it('preserves a red assertion verdict but rejects runner crashes', () => {
    const failed = {
      success: false,
      testResults: [
        {
          name: '/tree/src/red.unit.test.ts',
          assertionResults: [
            {
              fullName: 'red assertion',
              status: 'failed',
              failureMessages: ['assertion failed in /tree/src/red.unit.test.ts'],
            },
          ],
        },
      ],
    }
    expect(normalizeTestReport({ raw: failed, packageTree: '/tree', status: 1 })).toEqual({
      verdict: 'fail',
      suites: [
        {
          file: 'src/red.unit.test.ts',
          tests: [
            {
              name: 'red assertion',
              status: 'failed',
              failures: ['assertion failed in <package>/src/red.unit.test.ts'],
            },
          ],
        },
      ],
    })
    expect(() => normalizeTestReport({ raw: failed, packageTree: '/tree', status: 139 })).toThrow(
      'crash or collection failure',
    )
    expect(() =>
      normalizeTestReport({ raw: { ...report, success: false }, packageTree: '/tree', status: 1 }),
    ).toThrow('crash or collection failure')
  })

  it('publishes a passing artifact and rejects an unsupported result', async () => {
    const output = await mkdtemp(join(tmpdir(), 'test-verdict-'))
    try {
      await Bun.write(join(output, 'report.json'), JSON.stringify(report))
      await publishTestVerdict({
        output,
        operation: 'cell//pkg:test',
        packageTree: '/tree',
        report: join(output, 'report.json'),
        status: 0,
      })
      expect(await readTestVerdict({ output, operation: 'cell//pkg:test' })).toBe(0)
      await expect(readTestVerdict({ output, operation: 'cell//pkg:other' })).rejects.toThrow(
        'mismatch',
      )
    } finally {
      await rm(output, { recursive: true })
    }
  })
})
