import { expect, it } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { requireEditorPublicationInputs } from '../packages/@overeng/buck2-tools/src/editor-publication-inputs.ts'
import {
  editorPublicationIsolation,
  withEditorPublicationOwner,
} from '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts'
import { tool, withNativePublicationFixture } from './editor-publication-inputs.test-support.ts'

it('admits immutable inputs but rejects unowned symlink carriers before a real native build', async () => {
  await withNativePublicationFixture(async ({ root, build, stopPrivate, privateIsRetired }) => {
    const immutableInput = realpathSync(tool('BUN_BIN'))
    expect(() => requireEditorPublicationInputs({ root, paths: [immutableInput] })).not.toThrow()
    const immutableCarrier = join(root, 'buck-out', 'unowned-carrier', 'immutable-carrier')
    mkdirSync(dirname(immutableCarrier), { recursive: true })
    symlinkSync(immutableInput, immutableCarrier)
    expect(() => requireEditorPublicationInputs({ root, paths: [immutableCarrier] })).toThrow()
    expect(existsSync(join(root, 'buck-out', 'v2'))).toBe(false)
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        let failure: { cause: unknown } | undefined
        try {
          expect(await build(owner)).toContain(`/buck-out/${editorPublicationIsolation}/`)
        } catch (cause) {
          failure = { cause }
        }
        if (privateIsRetired() === false) {
          try {
            stopPrivate(owner)
          } catch (cause) {
            failure = {
              cause:
                failure === undefined
                  ? cause
                  : new AggregateError([failure.cause, cause], 'Native admission and daemon retirement failed', {
                      cause: failure.cause,
                    }),
            }
          }
        }
        if (failure !== undefined) throw failure.cause
      },
    })
  })
}, 600_000)
