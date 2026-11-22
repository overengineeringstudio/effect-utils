import { expect, it } from 'bun:test'
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import {
  editorPublicationIsolation,
  requireEditorPublicationOwner,
  withEditorPublicationOwner,
} from '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts'
import {
  publishEditorView,
  verifyEditorViewSnapshot,
} from '../packages/@overeng/buck2-tools/src/editor-view.ts'
import { tool, withNativePublicationFixture } from './editor-publication-inputs.test-support.ts'

const inventory = (root: string): unknown[] => {
  const entries: unknown[] = []
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name)
    const status = lstatSync(path, { bigint: true })
    if (status.isDirectory() === true) {
      entries.push([path, status.dev, status.ino])
      for (const entry of inventory(path)) entries.push(entry)
    } else entries.push([path, status.dev, status.ino, readFileSync(path).toString('hex')])
  }
  return entries
}

it('keeps private publication inputs intact while default Buck restarts and rematerializes during verify', async () => {
  await withNativePublicationFixture(
    async ({ root, authority, run, build, measured, stopPrivate, privateIsRetired }) => {
      expect(existsSync(join(root, 'buck-out', 'v2'))).toBe(false)
      const defaultOutput = await measured({ name: 'coldDefaultBuildMs', action: () => build() })
      await withEditorPublicationOwner({
        root,
        run: async (owner) => {
          let publicationFailure: { cause: unknown } | undefined
          try {
            const output = await measured({
              name: 'coldPrivateBuildMs',
              action: () => build(owner),
            })
            expect(output).toContain(`/buck-out/${editorPublicationIsolation}/`)
            expect(output).not.toBe(defaultOutput)
            const before = inventory(output)
            let reachedVerify = false
            const options = {
              repoRoot: root,
              package: '.',
              viewName: 'root',
              cell: 'fixture',
              target: '//:inputs',
              publicationOwner: owner,
              editorInputs: join(output, 'editor_inputs'),
              nodeModules: join(output, 'node_modules'),
              backingRoots: [join(output, 'node_modules')],
              workspaceAuthority: authority,
              cp: tool('CP_BIN'),
              mv: tool('MV_BIN'),
              fingerprintTool: tool('FINGERPRINT_BIN'),
              consumerCache: join(root, '.devenv', 'vite-cache'),
              snapshotRetention: 2,
              snapshotGraceMs: 0,
              contentStore: join(root, 'content', 'v1'),
              admissionDirectory: join(root, 'fingerprint-admission'),
              beforeVerify: async () =>
                measured({
                  name: 'verifyBarrierMs',
                  action: async () => {
                    reachedVerify = true
                    expect(
                      requireEditorPublicationOwner({
                        root,
                        owner,
                      }),
                    ).toBe(owner)
                    await measured({
                      name: 'defaultDaemonStopMs',
                      action: () => run({ args: ['kill'] }),
                    })
                    await measured({
                      name: 'defaultOutputCleanMs',
                      action: () => run({ args: ['--isolation-dir', 'v2', 'clean'] }),
                    })
                    expect(existsSync(defaultOutput)).toBe(false)
                    expect(
                      await measured({
                        name: 'defaultRestartRematerializeMs',
                        action: () => build(),
                      }),
                    ).toBe(defaultOutput)
                    expect(
                      readFileSync(join(defaultOutput, 'node_modules', 'dep', 'index.js'), 'utf8'),
                    ).toBe('export default 1\n')
                    expect(inventory(output)).toEqual(before)
                  },
                }),
            }
            const record = await measured({
              name: 'privatePublicationMs',
              action: () => publishEditorView(options),
            })
            expect(reachedVerify).toBe(true)
            expect(inventory(output)).toEqual(before)
            expect(await verifyEditorViewSnapshot(options)).toEqual(record)
          } catch (cause) {
            publicationFailure = { cause }
          }
          if (privateIsRetired() === false) {
            try {
              stopPrivate(owner)
            } catch (cause) {
              publicationFailure = {
                cause:
                  publicationFailure === undefined
                    ? cause
                    : new AggregateError(
                        [publicationFailure.cause, cause],
                        'Private publication and daemon retirement failed',
                        { cause: publicationFailure.cause },
                      ),
              }
            }
          }
          if (publicationFailure !== undefined) throw publicationFailure.cause
        },
      })
    },
  )
}, 600_000)
