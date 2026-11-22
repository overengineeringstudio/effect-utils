import { expect, it } from 'bun:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { withEditorPublicationOwner } from '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts'
import { editorPublicationIsolation } from '../packages/@overeng/buck2-tools/src/editor-publication-owner.ts'
import {
  runEditorViewAuthorityCommand,
  writeEditorViewAuthority,
} from '../packages/@overeng/buck2-tools/src/editor-view-authority.ts'
import { withNativePublicationFixture } from './editor-publication-inputs.test-support.ts'

it('defers real native authority census until exclusive publication admission', async () => {
  await withNativePublicationFixture(
    async ({ root, buck, git, authority, run, measured, stopPrivate, privateIsRetired }) => {
      const previousAuthority = readFileSync(authority, 'utf8')
      const censusComplete = new Error('Authority census completed before the build phase')
      let preparingAuthority = false
      let census: Promise<unknown> | undefined
      await withEditorPublicationOwner({
        root,
        run: async () => {
          census = withEditorPublicationOwner({
            root,
            run: async (owner) => {
              preparingAuthority = true
              let censusFailure: { cause: unknown } | undefined
              try {
                await measured('authorityCensusMs', () =>
                  writeEditorViewAuthority({
                    repoRoot: root,
                    workspaceRoot: root,
                    requiredPackages: ['.'],
                    cell: 'fixture',
                    buck2: buck,
                    git,
                    output: authority,
                    runCommand: async (command) =>
                      command.command !== buck
                        ? runEditorViewAuthorityCommand(command)
                        : {
                            status: 0,
                            stdout: Buffer.from(
                              await run(
                                ['--isolation-dir', editorPublicationIsolation, ...command.args],
                                owner,
                              ),
                            ),
                            stderr: Buffer.alloc(0),
                          },
                  }),
                )
              } catch (cause) {
                censusFailure = { cause }
              }
              try {
                if (privateIsRetired() === false) stopPrivate(owner)
              } catch (cause) {
                censusFailure = {
                  cause:
                    censusFailure === undefined
                      ? cause
                      : new AggregateError(
                          [censusFailure.cause, cause],
                          'Authority census and daemon retirement failed',
                          { cause: censusFailure.cause },
                        ),
                }
              }
              if (censusFailure !== undefined) throw censusFailure.cause
              throw censusComplete
            },
          }).then(
            () => undefined,
            (cause: unknown) => cause,
          )
          expect(preparingAuthority).toBe(false)
          expect(readFileSync(authority, 'utf8')).toBe(previousAuthority)
        },
      })
      assert(census, 'contended census was started')
      expect(await census).toBe(censusComplete)
      expect(preparingAuthority).toBe(true)
      expect(JSON.parse(readFileSync(authority, 'utf8')).ownedPackages).toEqual(['.'])
      expect(existsSync(join(root, 'buck-out', 'v2'))).toBe(false)
    },
  )
}, 600_000)
