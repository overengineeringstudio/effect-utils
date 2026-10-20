import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const cliPath = fileURLToPath(new URL('../../bin/genie.tsx', import.meta.url))
const readersPath = fileURLToPath(new URL('../runtime/node/inputs.ts', import.meta.url))
const repoContextPath = fileURLToPath(new URL('../runtime/repo-context/mod.ts', import.meta.url))

const fixture = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'genie-input-manifest-'))
  const manifest = path.join(root, 'inputs.manifest')
  mkdirSync(path.join(root, '.git'))
  writeFileSync(path.join(root, 'input.txt'), 'first\n')
  writeFileSync(
    path.join(root, 'helper.ts'),
    `
import { defineRepoContext } from ${JSON.stringify(repoContextPath)}
import { inputExistsSync, inputReaddirSync, inputStatSync } from ${JSON.stringify(readersPath)}
const repo = defineRepoContext({ name: 'fixture', importMetaUrl: import.meta.url })
export const read = () => {
  inputReaddirSync(repo.rootPath)
  inputStatSync(repo.resolve('input.txt'))
  return repo.readText('input.txt') + (inputExistsSync(repo.resolve('optional.txt')) ? repo.readText('optional.txt') : '')
}
`,
  )
  writeFileSync(
    path.join(root, 'result.txt.genie.ts'),
    `
import { read } from './helper.ts'
export default { data: {}, stringify: () => read() }
`,
  )
  const run = (args: string[] = [], enabled = true) =>
    spawnSync('bun', [cliPath, '--cwd', root, '--writeable', '--json', ...args], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GENIE_INPUT_MANIFEST: enabled ? manifest : '',
        XDG_STATE_HOME: path.join(root, 'state'),
      },
    })
  return { root, manifest, run }
}

describe('generator input manifests', () => {
  it('records transitive helpers, real reads, directory probes and missing optional inputs across CLI runs', () => {
    const { root, manifest, run } = fixture()
    try {
      const first = run()
      expect(first.status, first.stdout + first.stderr).toBe(0)
      const lines = readFileSync(manifest, 'utf8').trimEnd().split('\n')
      expect(lines[0]).toBe('genie-inputs-v1')
      expect(lines.slice(1)).toEqual([...new Set(lines.slice(1))].sort())
      expect(lines.slice(1).every((input) => path.isAbsolute(input))).toBe(true)
      for (const input of [
        '',
        'input.txt',
        'optional.txt',
        'helper.ts',
        'result.txt.genie.ts',
        'megarepo.lock',
        'flake.lock',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'package.json',
      ]) {
        expect(lines).toContain(path.resolve(root, input))
      }
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('first\n')
      writeFileSync(path.join(root, 'optional.txt'), 'added\n')
      writeFileSync(path.join(root, 'input.txt'), 'changed\n')
      const second = run()
      expect(second.status, second.stdout + second.stderr).toBe(0)
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('changed\nadded\n')
      rmSync(path.join(root, 'optional.txt'))
      const third = run()
      expect(third.status, third.stdout + third.stderr).toBe(0)
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('changed\n')
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([false, true])(
    'records nested recursive directory membership (withFileTypes=%s)',
    (withFileTypes) => {
      const { root, manifest, run } = fixture()
      try {
        const sources = path.join(root, 'sources')
        const nested = path.join(sources, 'nested', 'empty')
        mkdirSync(nested, { recursive: true })
        writeFileSync(
          path.join(root, 'result.txt.genie.ts'),
          `
import { inputReaddirSync } from ${JSON.stringify(readersPath)}
export default { data: {}, stringify: () => inputReaddirSync(${JSON.stringify(sources)}, {
  recursive: true, withFileTypes: ${withFileTypes},
}).map((entry) => typeof entry === 'string' ? entry : entry.name).sort().join('\\n') + '\\n' }
`,
        )
        const first = run()
        expect(first.status, first.stdout + first.stderr).toBe(0)
        const inputs = readFileSync(manifest, 'utf8').trimEnd().split('\n')
        expect(inputs).toContain(sources)
        expect(inputs).toContain(path.dirname(nested))
        expect(inputs).toContain(nested)
        const immediateBefore = readdirSync(sources)
        const previousOutput = readFileSync(path.join(root, 'result.txt'), 'utf8')
        writeFileSync(path.join(nested, 'new.txt'), 'new member')
        expect(readdirSync(sources)).toEqual(immediateBefore)
        const second = run()
        expect(second.status, second.stdout + second.stderr).toBe(0)
        expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).not.toBe(previousOutput)
        expect(readFileSync(manifest, 'utf8').split('\n')).toContain(path.join(nested, 'new.txt'))
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )

  it('follows a bare workspace package symlink and records its source and export metadata', () => {
    const { root, manifest, run } = fixture()
    try {
      const localPackage = path.join(root, 'local-helper')
      mkdirSync(localPackage)
      mkdirSync(path.join(root, 'node_modules'))
      writeFileSync(
        path.join(localPackage, 'package.json'),
        '{"name":"fixture-helper","exports":"./index.ts"}\n',
      )
      writeFileSync(path.join(localPackage, 'index.ts'), "export { read } from '../helper.ts'\n")
      symlinkSync(localPackage, path.join(root, 'node_modules', 'fixture-helper'), 'dir')
      writeFileSync(
        path.join(root, 'result.txt.genie.ts'),
        `
import { read } from 'fixture-helper'
export default { data: {}, stringify: () => read() }
`,
      )
      const result = run()
      expect(result.status, result.stdout + result.stderr).toBe(0)
      const inputs = readFileSync(manifest, 'utf8').trimEnd().split('\n')
      expect(inputs).toContain(path.join(localPackage, 'index.ts'))
      expect(inputs).toContain(path.join(localPackage, 'package.json'))
      expect(inputs).toContain(path.join(root, 'node_modules', 'fixture-helper', 'package.json'))
      expect(inputs).toContain(path.join(root, 'helper.ts'))
      expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('first\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('does not publish without opt-in, on dry/partial runs, or after a failed generation', () => {
    const { root, manifest, run } = fixture()
    try {
      const ordinary = run([], false)
      expect(ordinary.status, ordinary.stdout + ordinary.stderr).toBe(0)
      expect(existsSync(manifest)).toBe(false)
      writeFileSync(manifest, 'previous successful manifest\n')
      for (const args of [['--dry-run'], ['--phase', 'bootstrap']]) {
        const result = run(args)
        expect(result.status, result.stdout + result.stderr).toBe(0)
        expect(readFileSync(manifest, 'utf8')).toBe('previous successful manifest\n')
      }
      writeFileSync(path.join(root, 'result.txt.genie.ts'), "throw new Error('fixture failed')\n")
      expect(run().status).not.toBe(0)
      expect(readFileSync(manifest, 'utf8')).toBe('previous successful manifest\n')
      expect(readdirSync(root).some((name) => name.endsWith('.tmp'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
