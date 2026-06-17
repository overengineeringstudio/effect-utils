import { describe, expect, it } from 'vitest'

import type { BatchResult } from '../../batch.ts'
import type { StatusResult, SyncResult } from '../../sync.ts'
import type { TreeSyncResult } from '../../tree.ts'
import { syncErrorAction, syncResultAction } from './map.ts'
import { type SyncAction, initialSyncState, syncExitCode, syncReducer } from './schema.ts'

const PAGE = '00000000-0000-4000-8000-000000000001'

/** Minimal StatusResult stub — only the shape the rows ignore is needed. */
const status: StatusResult = {
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
}

const fold = (target: string, actions: SyncAction[]) =>
  actions.reduce((state, action) => syncReducer({ state, action }), initialSyncState(target))

describe('sync output mapping', () => {
  it('a single-page SyncResult maps to SetSingle and folds to Success with stages kept', () => {
    const single: SyncResult = {
      _tag: 'pushed',
      path: 'x.nmd',
      pageId: PAGE,
      status,
      push: { path: 'x.nmd', pageId: PAGE, pushed: true, status },
    }
    const action = syncResultAction(single)
    expect(action).toEqual({ _tag: 'SetSingle', outcome: 'pushed' })
    const state = fold('x.nmd', [
      { _tag: 'StageSucceed', id: 'write-body', label: 'write-body' },
      action,
    ])
    expect(state._tag).toBe('Success')
    if (state._tag === 'Success') {
      expect(state.multi).toBe(false)
      expect(state.stages).toHaveLength(1)
      expect(syncExitCode(state)).toBe(0)
    }
  })

  it('a directory TreeSyncResult maps to per-page rows (one per TreeOp)', () => {
    const tree: TreeSyncResult = {
      _tag: 'tree',
      root: 'docs',
      rootPageId: PAGE,
      rootFile: 'index.nmd',
      direction: 'local',
      plan: false,
      ops: [
        { _tag: 'update', relPath: 'index.nmd', pageId: PAGE },
        { _tag: 'create', relPath: 'guide/setup.nmd', title: 'Setup', pageId: PAGE },
        { _tag: 'noop', relPath: 'guide/usage.nmd', pageId: PAGE },
      ],
    }
    const action = syncResultAction(tree)
    expect(action).toEqual({
      _tag: 'SetPages',
      pages: [
        { path: 'index.nmd', outcome: 'updated' },
        { path: 'guide/setup.nmd', outcome: 'created' },
        { path: 'guide/usage.nmd', outcome: 'noop' },
      ],
    })
    const state = fold('docs', [action])
    expect(state._tag).toBe('Success')
    if (state._tag === 'Success') {
      expect(state.multi).toBe(true)
      expect(state.pages).toHaveLength(3)
      expect(syncExitCode(state)).toBe(0)
    }
  })

  it('a batch result maps success rows to their SyncResult tag and failures to error', () => {
    const batch: BatchResult<SyncResult> = {
      _tag: 'batch',
      operation: 'sync',
      total: 2,
      succeeded: 1,
      failed: 1,
      items: [
        {
          _tag: 'success',
          operation: 'sync',
          path: 'a.nmd',
          result: {
            _tag: 'pulled',
            path: 'a.nmd',
            pageId: PAGE,
            status,
            pull: { path: 'a.nmd', pageId: PAGE, storage: 'self_contained' },
          },
        },
        { _tag: 'error', operation: 'sync', path: 'b.nmd', error: new Error('boom') },
      ],
    }
    const action = syncResultAction(batch)
    expect(action).toEqual({
      _tag: 'SetPages',
      pages: [
        { path: 'a.nmd', outcome: 'pulled' },
        { path: 'b.nmd', outcome: 'error' },
      ],
    })
  })

  it('a tree conflict row folds to the Conflict state with a per-page WARNING (multi → exit 0)', () => {
    const action = syncResultAction({
      _tag: 'tree',
      root: 'docs',
      rootPageId: PAGE,
      rootFile: 'index.nmd',
      direction: 'local',
      plan: false,
      ops: [{ _tag: 'conflict', relPath: 'a.nmd', pageId: PAGE }],
    })
    const state = fold('docs', [action])
    expect(state._tag).toBe('Conflict')
    if (state._tag === 'Conflict') {
      expect(state.multi).toBe(true)
      expect(state.warnings[0]?.name).toBe('a.nmd')
      expect(syncExitCode(state)).toBe(0)
    }
  })

  it('a single-page conflict failure maps to SetSingle conflict (multi=false → exit 7)', () => {
    const action = syncErrorAction({ _tag: 'NmdConflictError', message: 'both changed' })
    expect(action).toEqual({ _tag: 'SetSingle', outcome: 'conflict' })
    const state = fold('x.nmd', [action])
    expect(state._tag).toBe('Conflict')
    if (state._tag === 'Conflict') {
      expect(state.multi).toBe(false)
      expect(syncExitCode(state)).toBe(7)
    }
  })

  it('a non-conflict failure maps to SetError → exit 1', () => {
    const action = syncErrorAction({ _tag: 'NmdGatewayError', message: 'boom' })
    expect(action).toEqual({ _tag: 'SetError', message: '[object Object]' })
    const state = fold('x.nmd', [action])
    expect(state._tag).toBe('Error')
    if (state._tag === 'Error') expect(syncExitCode(state)).toBe(1)
  })
})
