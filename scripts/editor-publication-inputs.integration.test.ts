import { expect, it } from 'bun:test'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'

import {
  editorPublicationIsolation,
  requireEditorPublicationOwner,
  withEditorPublicationOwner,
} from '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts'
import {
  checkEditorView,
  dispatchEditorView,
  publishEditorViews,
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
            const { publicationOwner: admittedOwner, ...unowned } = options
            expect(admittedOwner).toBe(owner)
            for (const invoke of [publishEditorView, checkEditorView]) {
              await expect(invoke(unowned)).rejects.toThrow()
              await expect(invoke({
                ...options,
                editorInputs: join(defaultOutput, 'editor_inputs'),
              })).rejects.toThrow('outside its reserved Buck isolation')
            }
            await expect(publishEditorViews({ options: [unowned] })).rejects.toThrow()
            const cli = [
              'check', '--repo-root', root, '--package', '.', '--view-name', 'root',
              '--cell', 'fixture', '--target', '//:inputs',
              '--editor-inputs', options.editorInputs, '--node-modules', options.nodeModules,
              '--backing-root', options.nodeModules, '--workspace-authority', authority,
              '--cp', options.cp, '--mv', options.mv, '--fingerprint-tool', options.fingerprintTool,
              '--consumer-cache', options.consumerCache, '--snapshot-retention', '2',
            ]
            // Dispatch rejects; only the executable main maps failures to process status.
            await expect(dispatchEditorView({ args: cli })).rejects.toThrow(
              'live in-process publication owner',
            )
            expect(reachedVerify).toBe(false)
            const record = await measured({
              name: 'privatePublicationMs',
              action: () => publishEditorView(options),
            })
            expect(reachedVerify).toBe(true)
            const privateRoot = join(root, 'buck-out', editorPublicationIsolation)
            mkdirSync(join(privateRoot, 'sub'), { recursive: true })
            mkdirSync(join(privateRoot, 'buck-out/v2'), { recursive: true })
            symlinkSync(join(privateRoot, 'sub'), join(root, 'alias'))
            symlinkSync(options.nodeModules, join(privateRoot, 'buck-out/v2/inputs'))
            mkdirSync(join(root, 'buck-out/v2/inputs'))
            const spelling = `${root}/alias/../buck-out/v2/inputs`
            const admitted = {
              ...options,
              repoRoot: relative(process.cwd(), root),
              nodeModules: spelling,
              workspaceAuthority: 'workspace-authority.json',
            }
            await checkEditorView(admitted)
            await publishEditorViews({ options: [admitted] })
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
