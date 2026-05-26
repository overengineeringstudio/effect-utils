import { Effect, Schema, Stream } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  AbsolutePath,
  BodyPointer,
  Hash,
  PageId,
  WorkspaceRelativePath,
  bodyPathForRow,
  canonicalizeWorkspaceRelativePath,
  classifyLocalDelete,
  isOwnWriteObservation,
  makeFakeLocalWorkspacePort,
  presentArtifactObservation,
} from '../mod.ts'

const decode = <TSchema extends Schema.Schema.AnyNoContext>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const hash = (char: string) => decode(Hash, `sha256:${char.repeat(64)}`)

const pageId = decode(PageId, 'page-1')
const otherPageId = decode(PageId, 'page-2')
const root = decode(AbsolutePath, '/workspace')

describe('local workspace contract', () => {
  it('derives root-relative title slugs with row ID suffixes', () => {
    expect(bodyPathForRow({ title: 'Weekly Notes', pageId })).toEqual({
      _tag: 'allowed',
      path: 'weekly-notes--page-1.nmd',
    })
  })

  it('claims canonical paths and reports collisions without overwriting', async () => {
    const path = decode(WorkspaceRelativePath, 'weekly-notes--page-1.nmd')
    const workspace = makeFakeLocalWorkspacePort({
      claimedPaths: [{ _tag: 'PathClaimPlan', pageId, path }],
    })

    const result = await Effect.runPromise(
      workspace.claimPath({
        _tag: 'PathClaimPlan',
        pageId: otherPageId,
        path,
      }),
    )

    expect(result).toEqual({
      _tag: 'conflict',
      pageId: otherPageId,
      requestedPath: path,
      existingPageId: pageId,
    })
  })

  it('rejects traversal and symlink escapes from the workspace root', async () => {
    for (const path of ['../escape.nmd', '/rooted.nmd', 'foo/../../escape.nmd']) {
      expect(canonicalizeWorkspaceRelativePath({ path })).toMatchObject({
        _tag: 'blocked',
        guard: 'PathEscapesRoot',
      })
    }

    const workspace = makeFakeLocalWorkspacePort({ symlinkEscapes: ['linked'] })
    const failure = await Effect.runPromise(
      Effect.flip(
        workspace.claimPath({
          _tag: 'PathClaimPlan',
          pageId,
          path: decode(WorkspaceRelativePath, 'linked/page.nmd'),
        }),
      ),
    )

    expect(failure).toMatchObject({
      _tag: 'LocalStoreError',
      operation: 'claimPath',
    })
    await expect(
      Effect.runPromise(
        workspace.claimPath({
          _tag: 'PathClaimPlan',
          pageId,
          path: decode(WorkspaceRelativePath, 'safe/page.nmd'),
        }),
      ),
    ).resolves.toMatchObject({ _tag: 'claimed' })
  })

  it.each(['foo//bar.nmd', 'foo/./bar.nmd', 'foo/\u0000/bar.nmd', 'aux/page.nmd'])(
    'rejects unsafe workspace path segments: %s',
    (path) => {
      expect(canonicalizeWorkspaceRelativePath({ path })).toMatchObject({
        _tag: 'blocked',
        guard: 'PathEscapesRoot',
      })
    },
  )

  it('keeps local deletes as candidates instead of remote trash by default', () => {
    const path = decode(WorkspaceRelativePath, 'weekly-notes--page-1.nmd')

    expect(classifyLocalDelete({ pageId, path })).toEqual({
      _tag: 'local-delete-candidate',
      pageId,
      path,
      remoteTrash: 'blocked-by-default',
    })
  })

  it('emits own-write materialization suppression tokens', async () => {
    const path = decode(WorkspaceRelativePath, 'weekly-notes--page-1.nmd')
    const bodyPointer = decode(BodyPointer, {
      _tag: 'BodyPointer',
      pageId,
      bodyHash: hash('a'),
      observedAt: '2026-05-25T00:00:00.000Z',
    })
    const workspace = makeFakeLocalWorkspacePort()

    const result = await Effect.runPromise(
      workspace.materialize({
        _tag: 'MaterializePlan',
        pageId,
        path,
        bodyPointer,
      }),
    )
    const observation = presentArtifactObservation({
      pageId,
      path,
      contentHash: result.bodyHash,
      observedAt: bodyPointer.observedAt,
      ownWriteSuppressionToken: result.ownWriteSuppressionToken,
    })

    expect(result.ownWriteSuppressionToken).toMatch(/^materialize:page-1:sha256:/)
    expect(isOwnWriteObservation({ observation, token: result.ownWriteSuppressionToken })).toBe(
      true,
    )
  })

  it('scans fake local observations through the LocalWorkspacePort shape', async () => {
    const path = decode(WorkspaceRelativePath, 'weekly-notes--page-1.nmd')
    const bodyPointer = decode(BodyPointer, {
      _tag: 'BodyPointer',
      pageId,
      bodyHash: hash('b'),
      observedAt: '2026-05-25T00:00:00.000Z',
    })
    const observation = presentArtifactObservation({
      pageId,
      path,
      contentHash: hash('b'),
      observedAt: bodyPointer.observedAt,
    })
    const workspace = makeFakeLocalWorkspacePort({ observations: [observation] })

    const observations = await Effect.runPromise(Stream.runCollect(workspace.scan(root)))

    expect(Array.from(observations)).toEqual([observation])
  })
})
