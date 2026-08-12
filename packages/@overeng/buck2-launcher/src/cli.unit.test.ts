import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { parseCli } from './cli.ts'
import { assertNoReservedEvidenceFlags, assertSupportedCommand, quoteCommand } from './launcher.ts'

describe('buck2-launcher CLI boundary', () => {
  it('preserves every Buck argument after the separator', () => {
    const parsed = parseCli(
      [
        '--buck',
        '/nix/store/abc-buck2/bin/buck2',
        '--run-id',
        'e2e-42',
        '--print-command',
        '--',
        'build',
        '//pkg:x',
        '--local-only',
      ],
      {},
    )
    expect(parsed.buckArgs).toEqual(['build', '//pkg:x', '--local-only'])
    expect(parsed.printCommand).toBe(true)
    expect(parsed.launcherRunId).toBe('e2e-42')
  })

  it('requires an already-resolved binary rather than evaluating Nix or devenv', () => {
    expect(() => parseCli(['--', 'build', '//:x'], {})).toThrow('--buck or BUCK2_BIN is required')
  })

  it('rejects evidence flag collisions with a bypass instruction', () => {
    expect(() => assertNoReservedEvidenceFlags(['build', '//:x', '--event-log=/tmp/x'])).toThrow(
      'bypass the launcher',
    )
  })

  it('allows reserved-looking flags owned by a launched program after passthrough', () => {
    expect(() =>
      assertNoReservedEvidenceFlags([
        'run',
        '//:tool',
        '--',
        '--event-log=program.log',
        '--build-report',
      ]),
    ).not.toThrow()
  })

  it('renders a shell-copyable underlying command only when requested', () => {
    expect(quoteCommand('/nix/store/a/buck2', ['build', '//:x', 'space value'])).toBe(
      "/nix/store/a/buck2 build //:x 'space value'",
    )
  })

  it('rejects commands which cannot produce a build report', () => {
    expect(() => assertSupportedCommand(['cquery', '//...'])).toThrow('bypass the launcher')
  })

  it('recognizes supported commands after Buck global options', () => {
    expect(() =>
      assertSupportedCommand([
        '--isolation-dir',
        'review-test',
        '--client-metadata=source=review',
        '-v',
        '2',
        'build',
        '//:x',
      ]),
    ).not.toThrow()
  })

  it.each(['-v2', '-v+2', '-v-1', '-v02'])(
    'recognizes Buck attached numeric verbosity %s before a supported command',
    (verbosity) => {
      expect(() => assertSupportedCommand([verbosity, 'build', '//:x'])).not.toThrow()
    },
  )

  it.each(['-vfoo', '-v1.0', '-v0x2', '-v_2'])(
    'rejects malformed attached verbosity %s instead of skipping it',
    (verbosity) => {
      expect(() => assertSupportedCommand([verbosity, 'build', '//:x'])).toThrow(
        `Buck command ${verbosity}`,
      )
    },
  )

  it('does not mistake a global option value for a supported command', () => {
    expect(() => assertSupportedCommand(['--isolation-dir', 'build', 'cquery', '//...'])).toThrow(
      'bypass the launcher',
    )
  })

  it('makes package E2E reject an incomplete launcher receipt before Nix import', async () => {
    const root = await mkdtemp(join(tmpdir(), 'buck2-package-e2e-incomplete-'))
    const fakeLauncher = join(root, 'fake-launcher')
    await writeFile(
      fakeLauncher,
      `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
const receiptDir = value('--evidence-dir') + '/' + value('--run-id')
fs.mkdirSync(receiptDir, { recursive: true })
fs.writeFileSync(receiptDir + '/receipt.json', JSON.stringify({
  schema: 'buck-run-receipt/v1',
  status: { success: true, exitCode: 0 },
  observation: {
    complete: false,
    verdict: 'incomplete',
    reasons: ['what-ran-query-failed'],
    whatRan: { exitCode: 9, parseComplete: true, semanticComplete: true },
    materialized: { exitCode: 0, parseComplete: true, semanticComplete: true },
  },
}))
`,
    )
    await chmod(fakeLauncher, 0o700)
    const script = fileURLToPath(
      new URL('../../../../scripts/buck2-package-e2e.sh', import.meta.url),
    )
    const result = spawnSync(
      'bash',
      [script, root, fakeLauncher, '//packages/@overeng/tui-core:typescript_input_plan'],
      { encoding: 'utf8', env: process.env },
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('observationally incomplete')
  })
})
