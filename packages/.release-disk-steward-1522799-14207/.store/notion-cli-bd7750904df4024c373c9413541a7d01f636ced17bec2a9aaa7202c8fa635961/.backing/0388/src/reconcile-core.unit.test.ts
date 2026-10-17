import { describe, expect, it } from 'vitest'

import type { NmdFrontmatterV2, NmdLocalState, NmdSyncStateV1 } from '@overeng/notion-effect-client'

import { decideReconcile, porcelainStatus, type ReconcileCompare } from './reconcile-core.ts'
import { decideShared, sharedPorcelain } from './reconcile-shared.ts'

const pageId = '00000000-0000-4000-8000-000000000001'

const frontmatter = (source: NmdFrontmatterV2['notion_md']['source']): NmdFrontmatterV2 => ({
  notion_md: {
    version: 2,
    api_version: '2026-03-11',
    object: 'page',
    source,
    page_id: pageId,
    parent: { _tag: 'page', id: '00000000-0000-4000-8000-000000000000' },
    page: { title: 'T', icon: null, cover: null, in_trash: false, is_locked: false },
    properties: {},
  },
})

const syncState: NmdSyncStateV1 = {
  version: 1,
  page_id: pageId,
  body: {
    format: 'notion-enhanced-markdown',
    hash: `sha256:${'a'.repeat(64)}`,
    base: {
      _tag: 'object_ref',
      role: 'base_snapshot',
      hash: `sha256:${'a'.repeat(64)}`,
      path: '.notion-md/objects/sha256/aa/aaa.json',
      media_type: 'application/json',
      byte_length: 1,
    },
    last_pulled_at: '2026-05-22T14:50:00.000Z',
    remote_last_edited_time: '2026-05-22T14:49:59.000Z',
    truncated: false,
    unknown_block_ids: [],
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
  read_only_properties: {},
  data_source: null,
}

const localBound: NmdLocalState = { _tag: 'local-bound', frontmatter: frontmatter('local'), pageId }
const localUnbound: NmdLocalState = { _tag: 'local-unbound', frontmatter: frontmatter('local') }
const remote: NmdLocalState = { _tag: 'remote', frontmatter: frontmatter('remote'), pageId }
const sharedBound: NmdLocalState = {
  _tag: 'shared-bound',
  frontmatter: frontmatter('shared'),
  pageId,
  syncState,
}

const cmp = (a: string, b: string): ReconcileCompare => ({ renderedLocal: a, currentRemote: b })

describe('decideReconcile — dispatch table (R34)', () => {
  it('local unbound ⇒ create (create-on-push)', () => {
    expect(decideReconcile({ local: localUnbound, compare: undefined })).toEqual({ _tag: 'create' })
  })

  it('local bound, equivalent (R33) ⇒ noop', () => {
    // cosmetically different but semantically equal must still noop
    expect(decideReconcile({ local: localBound, compare: cmp('*hi*', '_hi_') })).toEqual({
      _tag: 'noop',
    })
  })

  it('local bound, real change ⇒ push (mirror; local authority)', () => {
    expect(decideReconcile({ local: localBound, compare: cmp('hello', 'world') })).toEqual({
      _tag: 'push',
    })
  })

  it('remote, equivalent ⇒ noop', () => {
    expect(decideReconcile({ local: remote, compare: cmp('a', 'a') })).toEqual({ _tag: 'noop' })
  })

  it('remote, remote changed ⇒ pull (overwrite local body)', () => {
    expect(decideReconcile({ local: remote, compare: cmp('old', 'new') })).toEqual({ _tag: 'pull' })
  })

  it('shared bound ⇒ shared-defer (core never touches the base)', () => {
    expect(decideReconcile({ local: sharedBound, compare: cmp('a', 'b') })).toEqual({
      _tag: 'shared-defer',
    })
  })
})

describe('porcelainStatus — git-porcelain vocabulary (R36)', () => {
  it.each([
    ['noop', 'in-sync'],
    ['create', 'unbound'],
    ['push', 'local-ahead'],
    ['pull', 'remote-ahead'],
  ] as const)('%s ⇒ %s', (tag, word) => {
    expect(porcelainStatus({ _tag: tag } as never)).toBe(word)
  })

  it('refuse ⇒ diverged', () => {
    expect(porcelainStatus({ _tag: 'refuse', reason: 'x' })).toBe('diverged')
  })
})

describe('decideShared — the only base/merge path (R32)', () => {
  it('local ≡ remote ⇒ noop', () => {
    expect(decideShared({ baseBody: 'b', localBody: 'x', remoteBody: 'x' })).toEqual({
      _tag: 'noop',
    })
  })

  it('remote ≡ base, local changed ⇒ merge to local (accept local)', () => {
    expect(decideShared({ baseBody: 'base', localBody: 'local', remoteBody: 'base' })).toEqual({
      _tag: 'merge',
      merged: 'local',
    })
  })

  it('local ≡ base, remote changed ⇒ noop (accept remote, local refreshed)', () => {
    expect(decideShared({ baseBody: 'base', localBody: 'base', remoteBody: 'remote' })).toEqual({
      _tag: 'noop',
    })
  })

  it('both diverged, non-overlapping ⇒ merge', () => {
    const base = 'line1\nline2\nline3'
    const local = 'LINE1\nline2\nline3'
    const rmt = 'line1\nline2\nLINE3'
    const outcome = decideShared({ baseBody: base, localBody: local, remoteBody: rmt })
    expect(outcome._tag).toBe('merge')
  })

  it('both diverged, overlapping ⇒ conflict', () => {
    const base = 'line1\nline2'
    const local = 'LOCAL\nline2'
    const rmt = 'REMOTE\nline2'
    const outcome = decideShared({ baseBody: base, localBody: local, remoteBody: rmt })
    expect(outcome._tag).toBe('conflict')
  })

  it('sharedPorcelain maps noop⇒in-sync, conflict⇒diverged', () => {
    expect(sharedPorcelain({ _tag: 'noop' })).toBe('in-sync')
    expect(sharedPorcelain({ _tag: 'conflict', baseBody: '', localBody: '', remoteBody: '' })).toBe(
      'diverged',
    )
  })
})
