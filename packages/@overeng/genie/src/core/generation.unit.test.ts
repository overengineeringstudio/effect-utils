import { describe, expect, it } from 'vitest'

import { getHeaderComment } from './generation.ts'

describe('getHeaderComment', () => {
  it('uses Starlark comments for Buck2 files', () => {
    const expected = '# Generated file - DO NOT EDIT\n# Source: rules.genie.ts\n\n'

    expect(getHeaderComment({ targetFilePath: 'BUCK', sourceFile: 'rules.genie.ts' })).toBe(
      expected,
    )
    expect(
      getHeaderComment({ targetFilePath: 'prelude/rules.bzl', sourceFile: 'rules.genie.ts' }),
    ).toBe(expected)
    expect(
      getHeaderComment({ targetFilePath: 'tools/export.bxl', sourceFile: 'rules.genie.ts' }),
    ).toBe(expected)
  })
})
