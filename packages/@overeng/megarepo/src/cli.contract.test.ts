import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterAll, describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../bin/mr.ts', import.meta.url))
const workspaceRoot = mkdtempSync(join(tmpdir(), 'megarepo-cli-contract-'))
writeFileSync(join(workspaceRoot, 'megarepo.kdl'), 'members {\n}\n')

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true })
})

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the megarepo owner
 * with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 * The local-source version suffix is normalized, so version-string content is not gated by this
 * baseline.
 * Stack-trace frames are normalized, so effect-internal line numbers are not gated by this
 * baseline.
 */
const stripAnsi = (output: string) =>
  output.replace(
    // oxlint-disable-next-line no-control-regex -- CLI contract snapshots intentionally normalize terminal control bytes.
    /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
    '',
  )

const normalizeOutput = (output: string) =>
  stripAnsi(output)
    .replace(/ — running from local source \([^)]+\)/gu, '')
    .replace(/^ +at <anonymous> .+$/gmu, '')

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
  }
}

/**
 * The `mr add` help document, printed on stdout when argument validation fails
 * (Effect v4 renders help on stdout and diagnostics on stderr).
 */
const addHelpDoc = `DESCRIPTION
  Add a new member repository

USAGE
  mr add [flags] <repo>

ARGUMENTS
  repo string    Repository reference (github shorthand, URL, or path)

FLAGS
  --name, -n string      Override the member name (defaults to repo name)
  --sync, -s             Sync the added repo immediately
  --output, -o choice    Output mode: auto, tty, alt-screen, ci, ci-plain, log, json, ndjson (choices: auto, tty, alt-screen, ci, ci-plain, log, json, ndjson)

GLOBAL FLAGS
  --help, -h                                                          Show help information
  --version, -v                                                       Show version information
  --wizard                                                            Start wizard mode for a command
  --completions <bash|zsh|fish|sh>                                    Print shell completion script (choices: bash, zsh, fish, sh)
  --log-level <all|trace|debug|info|warn|warning|error|fatal|none>    Sets the minimum log level (choices: all, trace, debug, info, warn, warning, error, fatal, none)
  --cwd string                                                        Override the working directory
`

describe('megarepo CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['store help', ['store', '--help']],
    ['version', ['--version']],
    ['missing required repo', ['add']],
    ['invalid shell', ['env', '--shell', 'nope']],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })

  it.each([
    {
      name: 'dash-prefixed operand',
      args: ['add', '--', '--not-a-flag'],
      stdout:
        '{"_tag":"Error","error":"invalid_repo","message":"Invalid repo reference: --not-a-flag"}\n',
      stderr: 'AddCommandError: Invalid repo reference (mr 0.1.0)\n\n',
    },
    {
      name: 'parent flag-name collision',
      args: ['add', '--', '--cwd'],
      stdout: '{"_tag":"Error","error":"invalid_repo","message":"Invalid repo reference: --cwd"}\n',
      stderr: 'AddCommandError: Invalid repo reference (mr 0.1.0)\n\n',
    },
    {
      name: 'subcommand flag-name collision',
      args: ['add', '--', '--name'],
      stdout:
        '{"_tag":"Error","error":"invalid_repo","message":"Invalid repo reference: --name"}\n',
      stderr: 'AddCommandError: Invalid repo reference (mr 0.1.0)\n\n',
    },
    {
      name: 'multiple operands preserve order until positional arity is exhausted',
      args: ['add', '--', '--first', '--name', '--last'],
      stdout: addHelpDoc,
      stderr:
        '\nERROR\n  Unexpected positional arguments: "--name", "--last"\n' +
        '~effect/cli/CliError/ShowHelp: Help requested (mr 0.1.0)\n\n',
    },
    {
      name: 'empty trailing operands',
      args: ['add', '--'],
      stdout: addHelpDoc,
      stderr:
        '\nERROR\n  Missing required argument: repo\n' +
        '~effect/cli/CliError/ShowHelp: Help requested (mr 0.1.0)\n\n',
    },
  ])('retains nested terminator argv: $name', ({ args, stdout, stderr }) => {
    expect(runCli('--cwd', workspaceRoot, ...args)).toEqual({
      status: 1,
      signal: null,
      stdout,
      stderr,
    })
  })
})
