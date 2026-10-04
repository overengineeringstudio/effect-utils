import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const shell = realpathSync(
  execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
)
const bun = realpathSync(execFileSync(shell, ['-c', 'command -v bun'], { encoding: 'utf8' }).trim())

const runner = fileURLToPath(new URL('./javascript-runner.ts', import.meta.url))
const fingerprintTool = ((): string => {
  const tool = process.env['FINGERPRINT_BIN']
  if (tool === undefined || tool === '')
    throw new Error('declared test tool is unavailable: FINGERPRINT_BIN')
  return tool
})()

describe('JavaScript runner', () => {
  it('ignores ambient environment, dotenv discovery and package Bun preloads', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'javascript-runner-startup-'))
    const packageTree = join(root, 'package-tree')
    try {
      await mkdir(packageTree)
      await Promise.all([
        writeFile(join(packageTree, '.env'), 'Q17_DOTENV=leaked\n'),
        writeFile(join(packageTree, 'bunfig.toml'), 'preload = ["./preload.ts"]\n'),
        writeFile(join(packageTree, 'preload.ts'), 'process.env.Q17_PRELOAD = "leaked"\n'),
        writeFile(
          join(packageTree, 'probe.ts'),
          `console.log(JSON.stringify({
ambient: process.env.Q17_AMBIENT ?? null,
dotenv: process.env.Q17_DOTENV ?? null,
preload: process.env.Q17_PRELOAD ?? null,
declared: process.env.DECLARED,
}))`,
        ),
      ])
      const child = Bun.spawn(
        [
          bun,
          runner,
          'exec',
          bun,
          packageTree,
          'probe.ts',
          '--fingerprint-tool',
          fingerprintTool,
          '--env',
          'DECLARED',
          'literal',
        ],
        {
          env: { ...process.env, BUCK_SCRATCH_PATH: join(root, 'scratch'), Q17_AMBIENT: 'leaked' },
          stdin: 'ignore',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [stdout, stderr, status] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect(status, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        ambient: null,
        dotenv: null,
        preload: null,
        declared: 'literal',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('creates a declared nested writable directory before launching the command', async () => {
    const root = await mkdtemp(
      join(realpathSync(tmpdir()), 'javascript-runner-writable-directory-'),
    )
    const packageTree = join(root, 'package-tree')
    const scratch = join(root, 'scratch')
    try {
      await mkdir(packageTree)
      await writeFile(
        join(packageTree, 'assert-writable.ts'),
        `import { statSync } from 'node:fs'
const path = process.env.CACHE_PATH
if (path === undefined || statSync(path).isDirectory() === false) process.exit(73)
`,
      )

      const child = Bun.spawn(
        [
          bun,
          runner,
          'exec',
          bun,
          packageTree,
          'assert-writable.ts',
          '--fingerprint-tool',
          fingerprintTool,
          '--writable-directory',
          'CACHE_PATH',
          'cache/vitest',
        ],
        {
          env: { ...process.env, BUCK_SCRATCH_PATH: scratch },
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      )
      expect(await child.exited).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
