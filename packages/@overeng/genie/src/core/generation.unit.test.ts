import { describe, expect, it } from 'vitest'

import { addHeaderComment, getHeaderComment } from './generation.ts'

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

  it('uses shell comments for shell scripts', () => {
    expect(
      getHeaderComment({
        targetFilePath: 'genie/ci-scripts/run-with-nix-gc-race-retry.sh',
        sourceFile: 'run-with-nix-gc-race-retry.sh.genie.ts',
      }),
    ).toBe('# Generated file - DO NOT EDIT\n# Source: run-with-nix-gc-race-retry.sh.genie.ts\n\n')
  })
})

describe('getExpectedContent', () => {
  it('keeps shell shebangs before generated provenance', () => {
    expect(
      addHeaderComment({
        header: '# Generated file - DO NOT EDIT\n# Source: run.sh.genie.ts\n\n',
        content: '#!/usr/bin/env bash\nexit 0\n',
      }),
    ).toBe(
      [
        '#!/usr/bin/env bash',
        '# Generated file - DO NOT EDIT',
        '# Source: run.sh.genie.ts',
        '',
        'exit 0',
        '',
      ].join('\n'),
    )
  })

  it('keeps non-shell shebangs before generated provenance', () => {
    // A hashbang is only legal as the very first bytes of a file, so a banner emitted ahead of it
    // turns a `.mjs` into a SyntaxError rather than merely mis-executing it.
    expect(
      addHeaderComment({
        header: '// Generated file - DO NOT EDIT\n// Source: tool.mjs.genie.ts\n',
        content: '#!/usr/bin/env node\nexport const run = () => {}\n',
      }),
    ).toBe(
      [
        '#!/usr/bin/env node',
        '// Generated file - DO NOT EDIT',
        '// Source: tool.mjs.genie.ts',
        'export const run = () => {}',
        '',
      ].join('\n'),
    )
  })

  it('prepends the banner when there is no shebang', () => {
    expect(
      addHeaderComment({
        header: '// Generated file - DO NOT EDIT\n// Source: mod.ts.genie.ts\n',
        content: 'export const x = 1\n',
      }),
    ).toBe('// Generated file - DO NOT EDIT\n// Source: mod.ts.genie.ts\nexport const x = 1\n')
  })
})
