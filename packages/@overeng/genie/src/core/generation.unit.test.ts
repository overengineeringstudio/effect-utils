import { describe, expect, it } from 'vitest'

import { getHeaderComment } from './generation.ts'

describe('getHeaderComment', () => {
  it.each(['BUCK', 'defs.bzl', 'tooling.bxl'])(
    'uses Starlark comments for %s',
    (targetFilePath) => {
      expect(
        getHeaderComment({
          targetFilePath,
          sourceFile: `${targetFilePath}.genie.ts`,
        }),
      ).toBe(`# Generated file - DO NOT EDIT\n# Source: ${targetFilePath}.genie.ts\n\n`)
    },
  )
})
