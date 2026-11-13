import { describe, expect, it } from 'vitest'

import { renderGenieOutput } from '@overeng/genie/render'

const context = { cwd: '/workspace', location: 'buck2/dependencies', mode: 'check' as const }

describe('renderGenieOutput', () => {
  it.each([
    ['BUCK', '# Generated file - DO NOT EDIT\n# Source: BUCK.genie.ts\n\nbody\n'],
    ['package.json', 'body\n'],
    ['.watchmanconfig', 'body\n'],
    ['tsconfig.json', '// Generated file - DO NOT EDIT\n// Source: tsconfig.json.genie.ts\nbody\n'],
    ['config.yaml', '# Generated file - DO NOT EDIT\n# Source: config.yaml.genie.ts\n\nbody\n'],
    ['file.ts', '// Generated file - DO NOT EDIT\n// Source: file.ts.genie.ts\nbody\n'],
  ])('renders %s', (target, expected) => {
    expect(renderGenieOutput({ output: { stringify: () => 'body\n' }, context, genieFilePath: `/workspace/${target}.genie.ts` })).toBe(expected)
  })

  it('forwards the context and formats before adding the header', () => {
    expect(renderGenieOutput({
      output: { stringify: (ctx: typeof context) => { expect(ctx).toBe(context); return 'raw' } },
      context,
      genieFilePath: 'BUCK.genie.ts',
      format: (content) => `${content.toUpperCase()}\n`,
    })).toBe('# Generated file - DO NOT EDIT\n# Source: BUCK.genie.ts\n\nRAW\n')
  })

  it.each(['#!/bin/sh', '#!/bin/sh\necho hello\n', '#!/usr/bin/env node\r\nrun()\r\n'])('preserves leading shebang %j', (content) => {
    const result = renderGenieOutput({ output: { stringify: () => content }, context, genieFilePath: 'run.sh.genie.ts' })
    expect(result.startsWith(`${content.split('\n')[0]}\n# Generated file`)).toBe(true)
  })
})
