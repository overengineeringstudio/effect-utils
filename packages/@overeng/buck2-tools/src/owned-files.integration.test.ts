import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import {
  buckOwnedFilesReportPasses,
  runBuckOwnedFilesCensus,
  type OwnedFilesCommandRunner,
} from './owned-files.ts'

describe('owned-file census command', () => {
  it('uses Git candidates and one grouped Buck owner query', () => {
    const calls: Parameters<OwnedFilesCommandRunner>[0][] = []
    const runCommand: OwnedFilesCommandRunner = (invocation) => {
      calls.push(invocation)
      if (invocation.command === 'git' && invocation.args[0] === 'rev-parse') {
        return { status: 0, stdout: Buffer.from('/repo\n'), stderr: Buffer.alloc(0) }
      }
      if (invocation.command === 'git' && invocation.args[0] === 'ls-files') {
        return {
          status: 0,
          stdout: Buffer.from('src/z.ts\0src/a.ts\0src/missing.ts\0'),
          stderr: Buffer.alloc(0),
        }
      }
      if (invocation.command === 'buck-from-toolchain') {
        const argumentReference = invocation.args.at(-1)
        if (argumentReference === undefined || argumentReference.startsWith('@') === false) {
          throw new Error('Buck query must receive one argument-file reference')
        }
        expect(readFileSync(argumentReference.slice(1), 'utf8')).toBe(
          'src/a.ts\nsrc/missing.ts\nsrc/z.ts\n',
        )
        return {
          status: 0,
          stdout: Buffer.from(
            JSON.stringify({
              'src/a.ts': ['root//src:a'],
              'src/missing.ts': [],
              'src/z.ts': ['root//src:z', 'root//src:all'],
            }),
          ),
          stderr: Buffer.alloc(0),
        }
      }
      throw new Error(`unexpected command: ${invocation.command} ${invocation.args.join(' ')}`)
    }

    const report = runBuckOwnedFilesCensus({
      cwd: '/worktree/subdirectory',
      buck2: 'buck-from-toolchain',
      runCommand,
    })

    expect(calls).toHaveLength(3)
    expect(calls[1]).toEqual({
      command: 'git',
      args: ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'],
      cwd: '/repo',
    })
    expect(calls[2]?.command).toBe('buck-from-toolchain')
    expect(calls[2]?.args.slice(0, -1)).toEqual(['uquery', '--output-format', 'json', 'owner(%s)'])
    expect(report.files.map(({ ownership }) => ownership)).toEqual([
      'owned',
      'unowned',
      'multiply-owned',
    ])
    expect(buckOwnedFilesReportPasses(report)).toBe(false)
  })
})
