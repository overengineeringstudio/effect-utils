import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const mr = fileURLToPath(new URL('../../bin/mr.ts', import.meta.url))

it('delegates grammar, relative paths, parent attribution, JSON streams and exit codes without reinterpretation', () => {
  const root = mkdtempSync(join(tmpdir(), 'lease-front-'))
  try {
    const binary = join(root, 'native-boundary')
    const argv = join(root, 'argv')
    // A recording executable tests only the frontend boundary, not native lease semantics.
    writeFileSync(
      binary,
      `#!/bin/sh
printf '%s\\n' "$@" > "$LEASE_ARGS"
printf '{"_tag":"BoundaryResult"}\\n'
printf '{"_tag":"BoundaryDiagnostic"}\\n' >&2
exit "$LEASE_EXIT"
`,
      { mode: 0o700 },
    )
    const invoke = (args: ReadonlyArray<string>, code = 0) => {
      const result = spawnSync('bun', [mr, '--cwd', root, 'worktree', 'lease', ...args], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          ...process.env,
          WORKTREE_LEASE_BIN: binary,
          LEASE_ARGS: argv,
          LEASE_EXIT: String(code),
          OTEL_SDK_DISABLED: 'true',
        },
      })
      expect(result.status, result.stderr).toBe(code)
      expect(result.stdout).toBe('{"_tag":"BoundaryResult"}\n')
      expect(result.stderr).toContain('{"_tag":"BoundaryDiagnostic"}\n')
      return readFileSync(argv, 'utf8').trimEnd().split('\n')
    }
    expect(
      invoke(['create', '.', '--purpose', 'gate', '--creator', 'agent/test', '--ttl', '60']),
    ).toEqual([
      'create',
      `${root}/.`,
      '--purpose',
      'gate',
      '--creator',
      'agent/test',
      '--ttl',
      '60',
      '--holder-pid',
      String(process.pid),
    ])
    mkdirSync(join(root, 'physical/child'), { recursive: true })
    symlinkSync(join(root, 'physical/child'), join(root, 'alias'))
    expect(invoke(['inspect', 'alias/..', '--json'])).toEqual([
      'inspect',
      `${root}/alias/..`,
      '--json',
    ])
    expect(invoke(['inspect', 'child', '--json'])).toEqual([
      'inspect',
      join(root, 'child'),
      '--json',
    ])
    expect(invoke(['guard', '--git-dir', '.git'])).toEqual([
      'guard',
      '--git-dir',
      join(root, '.git'),
    ])
    expect(
      invoke(['renew', '.', '--holder-pid', '123', '--agent', 'agent/test', '--ttl', '60']),
    ).toEqual(['renew', `${root}/.`, '--holder-pid', '123', '--ttl', '60', '--agent', 'agent/test'])
    expect(
      invoke(['reap', '--common-dir', '.git', '--scheduled', '--', 'archive', '--yes']),
    ).toEqual(['reap', '--common-dir', join(root, '.git'), '--scheduled', '--', 'archive', '--yes'])
    for (const code of [75, 1, 2]) {
      expect(
        invoke(
          ['run', '.', '--mode', 'shared', '--try', '--json', '--', 'sh', '-c', 'exit 9'],
          code,
        ),
      ).toEqual([
        'run',
        `${root}/.`,
        '--mode',
        'shared',
        '--try',
        '--json',
        '--',
        'sh',
        '-c',
        'exit 9',
      ])
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 120_000)
