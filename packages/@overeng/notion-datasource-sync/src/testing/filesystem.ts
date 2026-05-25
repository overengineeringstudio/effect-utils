import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Chunk, Effect, Schema, Stream } from 'effect'

import { AbsolutePath, BodyPointer, Hash, PageId, WorkspaceRelativePath } from '../domain.ts'
import type { LocalWorkspacePortShape } from '../ports.ts'

export const decode = <TSchema extends Schema.Schema.AnyNoContext>(
  schema: TSchema,
  value: unknown,
): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

export const testHash = (value: string) =>
  decode(Hash, `sha256:${createHash('sha256').update(value).digest('hex')}`)

export const testPageId = (value: string) => decode(PageId, value)

export const testWorkspacePath = (value: string) => decode(WorkspaceRelativePath, value)

export const testBodyPointer = ({
  pageId,
  bodyHash = testHash('body'),
}: {
  readonly pageId: PageId
  readonly bodyHash?: typeof Hash.Type
}) =>
  decode(BodyPointer, {
    _tag: 'BodyPointer',
    pageId,
    bodyHash,
    observedAt: '2026-05-25T00:00:00.000Z',
  })

export const makeTempWorkspace = async () => {
  const root = decode(AbsolutePath, await mkdtemp(join(tmpdir(), 'notion-ds-sync-workspace-')))

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

export const collectWorkspaceScan = (
  workspace: LocalWorkspacePortShape,
  root: typeof AbsolutePath.Type,
) =>
  Effect.runPromise(workspace.scan(root).pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray)))
