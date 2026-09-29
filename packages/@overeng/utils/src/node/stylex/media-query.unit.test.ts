import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))

it('accepts tokenizer EOF but rejects trailing syntax under Bun', () => {
  const scenario = fileURLToPath(new URL('./media-query.bun-repro.ts', import.meta.url))
  const result = spawnSync(process.env.BUN_BIN ?? 'bun', [scenario], {
    cwd: packageRoot,
    encoding: 'utf8',
    env: { ...process.env, NODE_ENV: 'test' },
  })
  expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
    status: 0,
    stdout: 'tokenizer EOF ignored; trailing syntax rejected; media CSS emitted\n',
    stderr: '',
  })
})
