import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { makeTempGitEnvironment } from '@overeng/utils-dev/node-vitest'

const cliPath = fileURLToPath(new URL('../../bin/genie.tsx', import.meta.url))

describe('output lock state', () => {
  it('generates from a source root without writing lock state into the package', () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'genie-lock-location-')))
    try {
      const repo = path.join(root, 'repo')
      const sourceRoot = path.join(repo, 'src')
      const stateHome = path.join(root, 'state')
      mkdirSync(sourceRoot, { recursive: true })
      writeFileSync(
        path.join(sourceRoot, 'BUCK.genie.ts'),
        "export default { data: {}, stringify: () => 'fixture output\\n' }\n",
      )
      const env = makeTempGitEnvironment({ ...process.env, XDG_STATE_HOME: stateHome })
      const run = (cwd: string) => {
        const result = spawnSync('bun', [cliPath, '--cwd', cwd, '--writeable', '--json'], {
          cwd,
          env,
          encoding: 'utf8',
        })
        expect(result.status, result.stderr + result.stdout).toBe(0)
        expect(readFileSync(path.join(sourceRoot, 'BUCK'), 'utf8')).toContain('fixture output\n')
      }
      run(sourceRoot)
      expect(existsSync(path.join(sourceRoot, 'tmp'))).toBe(false)
      const key = `genie:file:${createHash('sha256')
        .update(path.join(sourceRoot, 'BUCK'))
        .digest('hex')}`
      expect(readdirSync(path.join(stateHome, 'genie/locks'))).toEqual([encodeURIComponent(key)])
      // Changing discovery cwd must not create a separate lock namespace for the same output.
      run(repo)
      expect(existsSync(path.join(repo, 'tmp'))).toBe(false)
      expect(readdirSync(path.join(stateHome, 'genie/locks'))).toEqual([encodeURIComponent(key)])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})
