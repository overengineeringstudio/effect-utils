import { mkdir, readFile, rename, symlink, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { Effect, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  bodyPathForRow,
  classifyLocalDelete,
  filesystemWorkspacePageSidecarPath,
  isOwnWriteObservation,
  makeFilesystemLocalWorkspacePort,
} from '../local/workspace.ts'
import {
  collectWorkspaceScan,
  makeTempWorkspace,
  testBodyPointer,
  testHash,
  testPageId,
  testWorkspacePath,
} from '../testing/filesystem.ts'

describe('filesystem local workspace E2E', () => {
  it('persists canonical path claims and reports case-folding collisions', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const pageId = testPageId('page-1')
      const otherPageId = testPageId('page-2')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const sameCanonicalPath = testWorkspacePath('Weekly-Notes--Page-1.nmd')

      await expect(
        Effect.runPromise(
          workspace.claimPath({
            _tag: 'PathClaimPlan',
            pageId,
            path,
          }),
        ),
      ).resolves.toEqual({
        _tag: 'claimed',
        pageId,
        path,
      })

      await expect(
        Effect.runPromise(
          workspace.claimPath({
            _tag: 'PathClaimPlan',
            pageId: otherPageId,
            path: sameCanonicalPath,
          }),
        ),
      ).resolves.toEqual({
        _tag: 'conflict',
        pageId: otherPageId,
        requestedPath: path,
        existingPageId: pageId,
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('reports Unicode-normalized path claim collisions', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const pageId = testPageId('page-1')
      const otherPageId = testPageId('page-2')
      const decomposedPath = testWorkspacePath('cafe\u0301--page-1.nmd')
      const composedPath = testWorkspacePath('café--page-1.nmd')

      await expect(
        Effect.runPromise(
          workspace.claimPath({
            _tag: 'PathClaimPlan',
            pageId,
            path: decomposedPath,
          }),
        ),
      ).resolves.toEqual({
        _tag: 'claimed',
        pageId,
        path: composedPath,
      })

      await expect(
        Effect.runPromise(
          workspace.claimPath({
            _tag: 'PathClaimPlan',
            pageId: otherPageId,
            path: composedPath,
          }),
        ),
      ).resolves.toEqual({
        _tag: 'conflict',
        pageId: otherPageId,
        requestedPath: composedPath,
        existingPageId: pageId,
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('rejects reserved/control paths and keeps generated title paths bounded', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const pageId = testPageId('page-1')

      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.claimPath({
              _tag: 'PathClaimPlan',
              pageId,
              path: testWorkspacePath('CON/body--page-1.nmd'),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'claimPath',
        message: expect.stringContaining('reserved segment'),
      })

      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.claimPath({
              _tag: 'PathClaimPlan',
              pageId,
              path: testWorkspacePath('bad\u0001name--page-1.nmd'),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'claimPath',
        message: expect.stringContaining('control character'),
      })

      const generated = bodyPathForRow({
        title: Array.from({ length: 80 }, () => 'Quarterly Sync').join(' '),
        pageId,
      })
      expect(generated).toMatchObject({ _tag: 'allowed' })
      if (generated._tag === 'allowed') {
        expect(generated.path).toMatch(/--page-1\.nmd$/)
        expect(generated.path.length).toBeLessThanOrEqual(136)
      }
    } finally {
      await fixture.cleanup()
    }
  })

  it('uses stable page-id suffixes for duplicate generated titles', () => {
    const first = bodyPathForRow({
      title: 'Weekly Notes',
      pageId: testPageId('page-1'),
    })
    const second = bodyPathForRow({
      title: 'Weekly Notes',
      pageId: testPageId('page-2'),
    })

    expect(first).toEqual({
      _tag: 'allowed',
      path: testWorkspacePath('weekly-notes--page-1.nmd'),
    })
    expect(second).toEqual({
      _tag: 'allowed',
      path: testWorkspacePath('weekly-notes--page-2.nmd'),
    })
  })

  it('rejects symlink escapes during materialization and scan', async () => {
    const fixture = await makeTempWorkspace()
    const outside = await makeTempWorkspace()
    try {
      await symlink(outside.root, join(fixture.root, 'linked'))
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.materialize({
              _tag: 'MaterializePlan',
              pageId: testPageId('page-1'),
              path: testWorkspacePath('linked/page--page-1.nmd'),
              bodyPointer: testBodyPointer({ pageId: testPageId('page-1') }),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'materialize',
        message: expect.stringContaining('symlink'),
      })

      await expect(
        Effect.runPromise(Effect.flip(Stream.runCollect(workspace.scan(fixture.root)))),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'scan',
        message: expect.stringContaining('symlink'),
      })
    } finally {
      await fixture.cleanup()
      await outside.cleanup()
    }
  })

  it('fails closed when page sidecar state is damaged', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path: testWorkspacePath('weekly-notes--page-1.nmd'),
          bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
        }),
      )
      await writeFile(
        filesystemWorkspacePageSidecarPath({ root: fixture.root, pageId }),
        '{ damaged',
        'utf8',
      )

      await expect(
        Effect.runPromise(Effect.flip(Stream.runCollect(workspace.scan(fixture.root)))),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'scan',
        message: expect.stringContaining('sidecar'),
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('fails closed instead of overwriting an unclaimed existing body file', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const bodyPath = join(fixture.root, path)
      await writeFile(bodyPath, 'local-only body\n', 'utf8')

      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.materialize({
              _tag: 'MaterializePlan',
              pageId,
              path,
              bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'materialize',
        message: expect.stringContaining('no sidecar or claim identity'),
      })
      await expect(readFile(bodyPath, 'utf8')).resolves.toBe('local-only body\n')
    } finally {
      await fixture.cleanup()
    }
  })

  it('fails closed instead of overwriting local edits on a claimed body file', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
        }),
      )
      const bodyPath = join(fixture.root, path)
      await writeFile(bodyPath, `${await readFile(bodyPath, 'utf8')}local edit\n`, 'utf8')
      const editedContent = await readFile(bodyPath, 'utf8')

      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.materialize({
              _tag: 'MaterializePlan',
              pageId,
              path,
              bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-b') }),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'materialize',
        message: expect.stringContaining('local edits'),
      })
      await expect(readFile(bodyPath, 'utf8')).resolves.toBe(editedContent)
    } finally {
      await fixture.cleanup()
    }
  })

  it('fails closed when duplicate sidecars claim the same body path', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const otherPageId = testPageId('page-2')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
        }),
      )
      const sidecar = JSON.parse(
        await readFile(filesystemWorkspacePageSidecarPath({ root: fixture.root, pageId }), 'utf8'),
      ) as Record<string, unknown>
      await writeFile(
        filesystemWorkspacePageSidecarPath({ root: fixture.root, pageId: otherPageId }),
        `${JSON.stringify({ ...sidecar, pageId: otherPageId }, null, 2)}\n`,
        'utf8',
      )

      await expect(
        Effect.runPromise(Effect.flip(Stream.runCollect(workspace.scan(fixture.root)))),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'scan',
        message: expect.stringContaining('sidecars conflict'),
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('suppresses own materialization writes only while the marker evidence still matches', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const bodyHash = testHash('body-a')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const result = await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: testBodyPointer({ pageId, bodyHash }),
        }),
      )

      const [ownWriteObservation] = await collectWorkspaceScan({ workspace, root: fixture.root })
      expect(ownWriteObservation).toMatchObject({
        pageId,
        path,
        contentHash: bodyHash,
        state: 'present',
        ownWriteSuppressionToken: result.ownWriteSuppressionToken,
      })
      expect(
        isOwnWriteObservation({
          observation: ownWriteObservation!,
          token: result.ownWriteSuppressionToken,
        }),
      ).toBe(true)

      const bodyPath = join(fixture.root, path)
      await writeFile(bodyPath, `${await readFile(bodyPath, 'utf8')}\nlocal edit\n`, 'utf8')
      const [localEditObservation] = await collectWorkspaceScan({ workspace, root: fixture.root })

      expect(localEditObservation).toMatchObject({
        pageId,
        path,
        state: 'present',
      })
      expect(localEditObservation?.contentHash).not.toBe(bodyHash)
      expect(localEditObservation?.ownWriteSuppressionToken).toBeUndefined()
    } finally {
      await fixture.cleanup()
    }
  })

  it('classifies missing materialized files as local delete candidates only', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
        }),
      )
      await unlink(join(fixture.root, path))

      await expect(collectWorkspaceScan({ workspace, root: fixture.root })).resolves.toEqual([
        expect.objectContaining({
          pageId,
          path,
          state: 'delete-candidate',
        }),
      ])
      expect(classifyLocalDelete({ pageId, path })).toEqual({
        _tag: 'local-delete-candidate',
        pageId,
        path,
        remoteTrash: 'blocked-by-default',
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('treats branch-like mass deletion as local repair candidates, not remote trash proof', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      const firstPageId = testPageId('page-1')
      const secondPageId = testPageId('page-2')
      const firstPath = testWorkspacePath('weekly-notes--page-1.nmd')
      const secondPath = testWorkspacePath('weekly-notes--page-2.nmd')

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId: firstPageId,
          path: firstPath,
          bodyPointer: testBodyPointer({ pageId: firstPageId, bodyHash: testHash('body-a') }),
        }),
      )
      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId: secondPageId,
          path: secondPath,
          bodyPointer: testBodyPointer({ pageId: secondPageId, bodyHash: testHash('body-b') }),
        }),
      )

      await unlink(join(fixture.root, firstPath))
      await unlink(join(fixture.root, secondPath))

      await expect(collectWorkspaceScan({ workspace, root: fixture.root })).resolves.toEqual([
        expect.objectContaining({
          pageId: firstPageId,
          path: firstPath,
          state: 'delete-candidate',
        }),
        expect.objectContaining({
          pageId: secondPageId,
          path: secondPath,
          state: 'delete-candidate',
        }),
      ])
      expect(classifyLocalDelete({ pageId: firstPageId, path: firstPath }).remoteTrash).toBe(
        'blocked-by-default',
      )
      expect(classifyLocalDelete({ pageId: secondPageId, path: secondPath }).remoteTrash).toBe(
        'blocked-by-default',
      )
    } finally {
      await fixture.cleanup()
    }
  })

  it('rebuilds a missing workspace body only after sidecar identity proves a prior materialization', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const unclaimedPageId = testPageId('page-2')
      const unclaimedPath = testWorkspacePath('orphaned--page-2.nmd')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
        }),
      )
      await unlink(join(fixture.root, path))

      await expect(collectWorkspaceScan({ workspace, root: fixture.root })).resolves.toEqual([
        expect.objectContaining({
          pageId,
          path,
          contentHash: testHash('body-a'),
          state: 'delete-candidate',
        }),
      ])
      await expect(
        Effect.runPromise(
          workspace.materialize({
            _tag: 'MaterializePlan',
            pageId,
            path,
            bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-b') }),
          }),
        ),
      ).resolves.toMatchObject({
        _tag: 'MaterializeResult',
        pageId,
        path,
        bodyHash: testHash('body-b'),
      })
      await expect(collectWorkspaceScan({ workspace, root: fixture.root })).resolves.toEqual([
        expect.objectContaining({
          pageId,
          path,
          contentHash: testHash('body-b'),
          state: 'present',
        }),
      ])

      await writeFile(join(fixture.root, unclaimedPath), 'orphaned body\n', 'utf8')
      await expect(
        Effect.runPromise(
          Effect.flip(
            workspace.materialize({
              _tag: 'MaterializePlan',
              pageId: unclaimedPageId,
              path: unclaimedPath,
              bodyPointer: testBodyPointer({
                pageId: unclaimedPageId,
                bodyHash: testHash('body-c'),
              }),
            }),
          ),
        ),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'materialize',
        message: expect.stringContaining('no sidecar or claim identity'),
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('treats path renames as repair work instead of title edits', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const originalPath = testWorkspacePath('weekly-notes--page-1.nmd')
      const renamedPath = testWorkspacePath('renamed-locally--page-1.nmd')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path: originalPath,
          bodyPointer: testBodyPointer({ pageId }),
        }),
      )
      await rename(join(fixture.root, originalPath), join(fixture.root, renamedPath))

      await expect(
        Effect.runPromise(Effect.flip(Stream.runCollect(workspace.scan(fixture.root)))),
      ).resolves.toMatchObject({
        _tag: 'LocalStoreError',
        operation: 'scan',
        message: expect.stringContaining('missing sidecar identity'),
      })
    } finally {
      await fixture.cleanup()
    }
  })

  it('ignores abandoned atomic-write temp files and keeps the sidecar-backed body authoritative', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const path = testWorkspacePath('weekly-notes--page-1.nmd')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })

      await Effect.runPromise(
        workspace.materialize({
          _tag: 'MaterializePlan',
          pageId,
          path,
          bodyPointer: testBodyPointer({ pageId, bodyHash: testHash('body-a') }),
        }),
      )
      await writeFile(join(fixture.root, `${path}.123.tmp`), 'interrupted write\n', 'utf8')

      await expect(collectWorkspaceScan({ workspace, root: fixture.root })).resolves.toEqual([
        expect.objectContaining({
          pageId,
          path,
          contentHash: testHash('body-a'),
          state: 'present',
        }),
      ])
    } finally {
      await fixture.cleanup()
    }
  })

  it('materializes parent directories without treating nested paths as traversal', async () => {
    const fixture = await makeTempWorkspace()
    try {
      const pageId = testPageId('page-1')
      const workspace = makeFilesystemLocalWorkspacePort({ root: fixture.root })
      await mkdir(join(fixture.root, 'rows'), { recursive: true })

      await expect(
        Effect.runPromise(
          workspace.materialize({
            _tag: 'MaterializePlan',
            pageId,
            path: testWorkspacePath('rows/weekly-notes--page-1.nmd'),
            bodyPointer: testBodyPointer({ pageId }),
          }),
        ),
      ).resolves.toMatchObject({
        _tag: 'MaterializeResult',
        path: 'rows/weekly-notes--page-1.nmd',
      })
    } finally {
      await fixture.cleanup()
    }
  })
})
