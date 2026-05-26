import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Chunk, Effect, Schema, Stream } from 'effect'

import { AbsolutePath, BodyPointer, Hash, PageId, WorkspaceRelativePath } from '../core/domain.ts'
import type { LocalWorkspacePortShape } from '../core/ports.ts'

/** Decode an unknown value against a schema using sync semantics — throws on invalid input (test-only helper, mirrors `Schema.decodeUnknownSync(schema)(value)`). */
export const decode = <TSchema extends Schema.Schema.AnyNoContext>({
  schema,
  value,
}: {
  readonly schema: TSchema
  readonly value: unknown
}): typeof schema.Type => Schema.decodeUnknownSync(schema)(value)

/** Build a decoded `Hash` branded fixture from an arbitrary string — useful for stable test assertions without constructing raw hex strings. */
export const testHash = (value: string) =>
  decode({ schema: Hash, value: `sha256:${createHash('sha256').update(value).digest('hex')}` })

/** Build a decoded `PageId` branded fixture from a plain string — avoids repeating `decode(PageId, ...)` at each call site. */
export const testPageId = (value: string) => decode({ schema: PageId, value })

/** Build a decoded `WorkspaceRelativePath` branded fixture from a plain string — avoids repeating `decode(WorkspaceRelativePath, ...)` at each call site. */
export const testWorkspacePath = (value: string) => decode({ schema: WorkspaceRelativePath, value })

/** Build a decoded `BodyPointer` fixture with a fixed `observedAt` timestamp — defaults to `testHash('body')` for the body hash. */
export const testBodyPointer = ({
  pageId,
  bodyHash = testHash('body'),
}: {
  readonly pageId: PageId
  readonly bodyHash?: typeof Hash.Type
}) =>
  decode({
    schema: BodyPointer,
    value: {
      _tag: 'BodyPointer',
      pageId,
      bodyHash,
      observedAt: '2026-05-25T00:00:00.000Z',
    },
  })

/** Create a temporary OS directory scoped to a single test run — returns the root path and a `cleanup()` helper that deletes it recursively. */
export const makeTempWorkspace = async () => {
  const root = decode({ schema: AbsolutePath, value: await mkdtemp(join(tmpdir(), 'notion-ds-sync-workspace-')) })

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

/** Run a workspace `scan` to completion and return all observed paths as a plain readonly array — convenience wrapper for synchronous assertions in tests. */
export const collectWorkspaceScan = ({
  workspace,
  root,
}: {
  readonly workspace: LocalWorkspacePortShape
  readonly root: typeof AbsolutePath.Type
}) =>
  Effect.runPromise(workspace.scan(root).pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray)))
