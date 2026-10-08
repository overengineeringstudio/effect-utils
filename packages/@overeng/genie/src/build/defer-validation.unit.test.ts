import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const cliPath = new URL('../../bin/genie.tsx', import.meta.url).pathname

describe('deferred validation repair transaction', () => {
  it('writes projections before repair and leaves the ordinary check strict', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-defer-validation-'))
    try {
      writeFileSync(
        join(root, 'config.json.genie.ts'),
        `export default {
  data: { key: 'value' },
  stringify: () => JSON.stringify({ key: 'value' }),
  validate: () => [{ severity: 'error', message: 'repair fixture remains invalid' }],
}`,
      )

      const deferred = spawnSync('bun', [cliPath, '--cwd', root, '--defer-validation'], {
        encoding: 'utf8',
      })
      expect(deferred.status).toBe(0)
      expect(existsSync(join(root, 'config.json'))).toBe(true)

      const checked = spawnSync('bun', [cliPath, '--cwd', root, '--check'], {
        encoding: 'utf8',
      })
      expect(checked.status).not.toBe(0)
      expect(`${checked.stdout}\n${checked.stderr}`).toContain('repair fixture remains invalid')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('pnpm lock projection during deferred validation', () => {
  it('limits the deferred marker to the repair phase and keeps the final check strict', () => {
    const root = mkdtempSync(join(tmpdir(), 'genie-pnpm-patch-'))
    try {
      writeFileSync(
        join(root, 'projection.json.genie.ts'),
        `const mode = process.env.GENIE_DEFER_VALIDATION === '1' ? 'old-lock' : 'new-lock'
export default {
  data: { mode },
  stringify: () => JSON.stringify({ mode }),
}`,
      )
      const inheritedEnv = { ...process.env, GENIE_DEFER_VALIDATION: '1' }
      const deferred = spawnSync('bun', [cliPath, '--cwd', root, '--defer-validation'], {
        encoding: 'utf8',
        env: inheritedEnv,
      })
      expect(deferred.status).toBe(0)
      expect(JSON.parse(readFileSync(join(root, 'projection.json'), 'utf8'))).toEqual({
        mode: 'old-lock',
      })

      const stale = spawnSync('bun', [cliPath, '--cwd', root, '--check'], {
        encoding: 'utf8',
        env: inheritedEnv,
      })
      expect(stale.status).not.toBe(0)

      const repaired = spawnSync('bun', [cliPath, '--cwd', root], {
        encoding: 'utf8',
        env: inheritedEnv,
      })
      expect(repaired.status).toBe(0)
      expect(JSON.parse(readFileSync(join(root, 'projection.json'), 'utf8'))).toEqual({
        mode: 'new-lock',
      })
      const checked = spawnSync('bun', [cliPath, '--cwd', root, '--check'], {
        encoding: 'utf8',
        env: inheritedEnv,
      })
      expect(checked.status).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
