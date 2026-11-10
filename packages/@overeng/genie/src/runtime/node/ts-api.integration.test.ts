import * as fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { runTsFileAnalysis } from './ts-api.ts'

describe('TypeScript API server death', () => {
  it.each([['exit 23', '23'], ['kill -KILL $$', '137']])(
    'fails fast with bounded stderr when the server runs %s',
    async (exit, status) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'genie-ts-api-test-'))
      const executable = path.join(directory, 'fake-server')
      const previous = process.env.GENIE_TYPESCRIPT_API_SERVER
      fs.writeFileSync(executable, `#!/bin/sh\ndd bs=1 count=1 >/dev/null 2>/dev/null\nprintf '%s' '${'x'.repeat(5000)}panic-tail' >&2\n${exit}\n`, { mode: 0o700 })
      process.env.GENIE_TYPESCRIPT_API_SERVER = executable
      const started = performance.now()
      try {
        const error = await runTsFileAnalysis({ cwd: directory, use: () => undefined }).catch((error: unknown) => error)
        expect(error).toBeInstanceOf(Error)
        const message = error instanceof Error ? error.message : ''
        const prefix = `TypeScript API server exited at updateSnapshot (status ${status}): `
        expect(message.startsWith(prefix)).toBe(true)
        expect(message.endsWith('panic-tail')).toBe(true)
        expect(Buffer.byteLength(message.slice(prefix.length))).toBeLessThanOrEqual(4096)
        expect(performance.now() - started).toBeLessThan(5000)
      } finally {
        if (previous === undefined) delete process.env.GENIE_TYPESCRIPT_API_SERVER
        else process.env.GENIE_TYPESCRIPT_API_SERVER = previous
        fs.rmSync(directory, { recursive: true, force: true })
      }
    },
    5000,
  )
})
