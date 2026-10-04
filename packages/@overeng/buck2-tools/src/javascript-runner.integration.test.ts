import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { text } from 'node:stream/consumers'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeVitestCollection, vitestCollectArgv } from './javascript-runner.ts'

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
        text(child.stdout),
        text(child.stderr),
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

  it('collects runtime-generated cases without executing their assertions', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'javascript-runner-collection-'))
    const packageTree = join(root, 'package-tree')
    const report = join(root, 'collection.json')
    try {
      await mkdir(join(packageTree, 'node_modules'), { recursive: true })
      await symlink(
        dirname(fileURLToPath(import.meta.resolve('vitest/package.json'))),
        join(packageTree, 'node_modules/vitest'),
      )
      await writeFile(join(packageTree, 'package.json'), JSON.stringify({ type: 'module' }))
      await writeFile(
        join(packageTree, 'vitest.config.ts'),
        "export default { test: { include: ['*.test.ts'] } }\n",
      )
      await writeFile(
        join(packageTree, 'register.ts'),
        `import { it } from 'vitest'
export const register = (name: string) => it(name, () => {
  throw new Error('collection must not execute assertions')
})
`,
      )
      await writeFile(
        join(packageTree, 'dynamic.test.ts'),
        "import { register } from './register.ts'\nregister('runtime-generated rule case')\n",
      )
      const child = Bun.spawn(
        [
          ...vitestCollectArgv({
            runtime: bun,
            packageTree,
            config: 'vitest.config.ts',
            report,
            tests: [],
            excludes: [],
            staticParse: false,
          }),
        ],
        { cwd: packageTree, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' },
      )
      expect(await child.exited).toBe(0)
      expect(
        normalizeVitestCollection({
          packageTree,
          raw: JSON.parse(await readFile(report, 'utf8')),
        }).tests,
      ).toEqual([{ file: 'dynamic.test.ts', name: 'runtime-generated rule case' }])
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
