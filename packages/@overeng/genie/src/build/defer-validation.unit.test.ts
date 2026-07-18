import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
