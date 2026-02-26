import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { rewriteHelpSubcommand } from './cli-help-rewrite.ts'

Vitest.describe('rewriteHelpSubcommand', () => {
  Vitest.it('rewrites `tool help subcmd` → `tool subcmd --help`', () => {
    expect(rewriteHelpSubcommand(['/usr/bin/node', '/app/cli.ts', 'help', 'commit'])).toEqual([
      '/usr/bin/node',
      '/app/cli.ts',
      'commit',
      '--help',
    ])
  })

  Vitest.it('rewrites `tool help` (no subcmd) → `tool --help`', () => {
    expect(rewriteHelpSubcommand(['/usr/bin/node', '/app/cli.ts', 'help'])).toEqual([
      '/usr/bin/node',
      '/app/cli.ts',
      '--help',
    ])
  })

  Vitest.it('passes through `tool subcmd --flag` unchanged', () => {
    const argv = ['/usr/bin/node', '/app/cli.ts', 'subcmd', '--flag']
    expect(rewriteHelpSubcommand(argv)).toEqual(argv)
  })

  Vitest.it('passes through `tool` (no args) unchanged', () => {
    const argv = ['/usr/bin/node', '/app/cli.ts']
    expect(rewriteHelpSubcommand(argv)).toEqual(argv)
  })

  Vitest.it('only rewrites first token after help: `tool help sub1 sub2` → `tool sub1 --help`', () => {
    expect(
      rewriteHelpSubcommand(['/usr/bin/node', '/app/cli.ts', 'help', 'sub1', 'sub2']),
    ).toEqual(['/usr/bin/node', '/app/cli.ts', 'sub1', '--help'])
  })
})
