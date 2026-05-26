import { Path } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect } from 'effect'
import { describe, expect, it } from 'vitest'

import { nmdObjectRelativePath } from '@overeng/notion-effect-client'

import { isSafeRelativePath } from './state-store.ts'

const withPath = async <A>(fn: (path: Path.Path) => A): Promise<A> =>
  Effect.runPromise(Path.Path.pipe(Effect.map(fn), Effect.provide(NodeContext.layer)))

describe('notion-md state store path safety', () => {
  it('accepts content-addressed object paths under the local metadata root', async () => {
    await expect(
      withPath((path) =>
        isSafeRelativePath({
          path,
          relativePath: nmdObjectRelativePath(`sha256:${'a'.repeat(64)}`),
        }),
      ),
    ).resolves.toBe(true)
  })

  it('rejects traversal and absolute object paths', async () => {
    await expect(
      withPath((path) => [
        isSafeRelativePath({ path, relativePath: '..' }),
        isSafeRelativePath({ path, relativePath: '../outside.json' }),
        isSafeRelativePath({ path, relativePath: '.notion-md/../../outside.json' }),
        isSafeRelativePath({ path, relativePath: '/tmp/outside.json' }),
      ]),
    ).resolves.toEqual([false, false, false, false])
  })
})
