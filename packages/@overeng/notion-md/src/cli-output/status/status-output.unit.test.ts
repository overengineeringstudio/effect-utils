import { describe, expect, it } from 'vitest'

import type { BatchResult } from '../../batch.ts'
import type { StatusResult } from '../../sync.ts'
import type { TreeSyncResult } from '../../tree.ts'
import { statusResultPayload } from './map.ts'
import { type StatusAction, initialStatusState, statusExitCode, statusReducer } from './schema.ts'

const PAGE = '00000000-0000-4000-8000-000000000001'

/** Build a StatusResult with the given change flags (rest defaulted clean). */
const status = (overrides: Partial<StatusResult> = {}): StatusResult => ({
  path: 'x.nmd',
  pageId: PAGE,
  localChanged: false,
  localPageMetadataChanged: false,
  localPropertiesChanged: false,
  remoteChanged: false,
  remoteBodyChanged: false,
  remotePageMetadataChanged: false,
  bodyHash: 'h',
  localBodyHash: 'h',
  remoteBodyHash: 'h',
  unresolvedUnknownBlocks: [],
  ...overrides,
})

const fold = (target: string, actions: StatusAction[]) =>
  actions.reduce((state, action) => statusReducer({ state, action }), initialStatusState(target))

describe('status output mapping', () => {
  it('a clean single file → no problems, an in-sync summary, exit 0', () => {
    const payload = statusResultPayload(status())
    expect(payload.problems).toHaveLength(0)
    expect(payload.summary).toEqual(['1 file', 'in sync'])
    const state = fold('x.nmd', [{ _tag: 'SetResult', result: payload }])
    expect(state._tag).toBe('Success')
    expect(statusExitCode(state)).toBe(0)
  })

  it('a remote-changed single file → a WARNING with a sync fix + a drift summary', () => {
    const payload = statusResultPayload(status({ remoteChanged: true }))
    expect(payload.problems).toHaveLength(1)
    expect(payload.problems[0]?.severity).toBe('warning')
    expect(payload.problems[0]?.status).toBe('remote-changed')
    expect(payload.problems[0]?.fixes[0]).toContain('notion-md sync')
    expect(payload.summary).toEqual(['1 file', 'drift'])
  })

  it('unresolved unknown blocks → a guarded WARNING naming the block types', () => {
    const payload = statusResultPayload(
      status({ unresolvedUnknownBlocks: ['equation', 'synced_block', 'equation'] }),
    )
    const guarded = payload.problems.find((problem) => problem.status === 'guarded')
    expect(guarded?.severity).toBe('warning')
    expect(guarded?.details).toContain('equation')
    expect(guarded?.details).toContain('synced_block')
    expect(payload.summary).toContain('3 unresolved blocks')
    // The section dedups instances into `<kind> <count>` rows (sorted by kind),
    // so duplicate block types collapse (no repeated rows / colliding keys).
    const blocksSection = payload.sections.find((s) => s.title === 'unknown-blocks')
    expect(blocksSection?.items).toEqual(['equation 2', 'synced_block 1'])
  })

  it('a directory tree (plan:true) → per-page rows + a conflict WARNING, exit 0', () => {
    const tree: TreeSyncResult = {
      _tag: 'tree',
      root: 'docs',
      rootPageId: PAGE,
      rootFile: 'index.nmd',
      direction: 'local',
      plan: true,
      ops: [
        { _tag: 'update', relPath: 'index.nmd', pageId: PAGE },
        { _tag: 'noop', relPath: 'guide/usage.nmd', pageId: PAGE },
        { _tag: 'conflict', relPath: 'reference/cli.nmd', pageId: PAGE },
      ],
    }
    const payload = statusResultPayload(tree)
    expect(payload.sections[0]?.title).toBe('pages')
    expect(payload.sections[0]?.items).toHaveLength(3)
    const conflict = payload.problems.find((problem) => problem.status === 'conflict')
    expect(conflict?.name).toBe('reference/cli.nmd')
    expect(payload.summary).toEqual(['3 pages', '1 update', '1 in sync', '1 conflict'])
    const state = fold('docs', [{ _tag: 'SetResult', result: payload }])
    expect(statusExitCode(state)).toBe(0)
  })

  it('a flat recursive batch → per-file rows, drift/guarded/failure WARNINGs', () => {
    const batch: BatchResult<StatusResult> = {
      _tag: 'batch',
      operation: 'status',
      total: 3,
      succeeded: 2,
      failed: 1,
      items: [
        { _tag: 'success', operation: 'status', path: 'a.nmd', result: status() },
        {
          _tag: 'success',
          operation: 'status',
          path: 'b.nmd',
          result: status({ path: 'b.nmd', remoteChanged: true }),
        },
        { _tag: 'error', operation: 'status', path: 'c.nmd', error: new Error('boom') },
      ],
    }
    const payload = statusResultPayload(batch)
    expect(payload.sections[0]?.title).toBe('files')
    expect(payload.sections[0]?.items).toHaveLength(3)
    expect(payload.summary).toEqual(['3 files', '1 failed'])
    expect(payload.problems.map((p) => p.name).sort()).toEqual(['b.nmd', 'c.nmd'])
  })

  it('a caught failure folds to Error → exit 1', () => {
    const state = fold('x.nmd', [{ _tag: 'SetError', message: 'NmdGatewayError: boom' }])
    expect(state._tag).toBe('Error')
    expect(statusExitCode(state)).toBe(1)
  })
})
