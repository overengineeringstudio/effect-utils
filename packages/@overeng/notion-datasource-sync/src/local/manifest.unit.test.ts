import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { AbsolutePath, type AbsolutePath as AbsolutePathType } from '../core/domain.ts'
import {
  dataFilePath,
  loadWorkspaceManifest,
  manifestFileName,
  manifestPath,
  objectsDir,
  pagesDirPath,
  stateSqlitePath,
  WorkspaceManifestV1,
  writeWorkspaceManifest,
  type WorkspaceManifestV1 as WorkspaceManifestV1Type,
} from './manifest.ts'

const decode = <TSchema extends Schema.Codec<any, any, never>>(schema: TSchema, value: unknown) =>
  Schema.decodeUnknownSync(schema)(value)

const sampleManifest = (): WorkspaceManifestV1Type =>
  decode(WorkspaceManifestV1, {
    namespace_version: 'v1',
    authority_mode: 'shared',
    data_sources: [
      {
        name: 'tasks',
        data_source_id: 'data-source-1',
        database_id: 'database-1',
        data_file: 'data/v1/tasks.sqlite',
        pages_dir: 'pages/v1/tasks',
      },
    ],
  })

describe('workspace manifest', () => {
  let root: AbsolutePathType

  beforeEach(() => {
    root = decode(AbsolutePath, mkdtempSync(join(tmpdir(), 'nds-manifest-')))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('round-trips through write -> read -> decode', async () => {
    const manifest = sampleManifest()
    await writeWorkspaceManifest({ workspaceRoot: root, manifest })

    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('tracked')
    if (result._tag !== 'tracked') return
    expect(result.manifest).toEqual(manifest)
  })

  it('derives versioned path constructors', () => {
    expect(manifestPath(root)).toBe(join(root, manifestFileName))
    expect(dataFilePath({ workspaceRoot: root, name: 'tasks' })).toBe(
      join(root, 'data', 'v1', 'tasks.sqlite'),
    )
    expect(pagesDirPath({ workspaceRoot: root, name: 'tasks' })).toBe(
      join(root, 'pages', 'v1', 'tasks'),
    )
    expect(stateSqlitePath(root)).toBe(join(root, '.notion', 'v1', 'state.sqlite'))
    expect(objectsDir(root)).toBe(join(root, '.notion', 'v1', 'objects'))
  })

  it('reports an absent manifest as untracked', () => {
    const result = loadWorkspaceManifest(root)
    expect(result).toEqual({ _tag: 'untracked', manifestPath: manifestPath(root) })
  })

  it('fails closed on an unknown namespace version', () => {
    writeFileSync(
      manifestPath(root),
      JSON.stringify({ namespace_version: 'v2', authority_mode: 'shared', data_sources: [] }),
    )
    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('unknown-namespace')
  })

  it('fails closed on a structurally invalid manifest', () => {
    writeFileSync(manifestPath(root), '{ not json')
    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('unknown-namespace')
  })

  it('fails closed on an unknown field in the manifest (no silent strip)', () => {
    writeFileSync(
      manifestPath(root),
      JSON.stringify({
        namespace_version: 'v1',
        authority_mode: 'shared',
        data_sources: [],
        future_field: 'unexpected',
      }),
    )
    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('unknown-namespace')
  })

  it('fails closed when a sibling non-v1 namespace artifact coexists, listing offending paths', async () => {
    await writeWorkspaceManifest({ workspaceRoot: root, manifest: sampleManifest() })
    mkdirSync(join(root, 'data', 'v2'), { recursive: true })
    writeFileSync(join(root, 'notion.workspace.v2.json'), '{}')

    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('mixed-namespace')
    if (result._tag !== 'mixed-namespace') return
    expect([...result.offendingPaths].sort()).toEqual(['data/v2', 'notion.workspace.v2.json'])
  })

  it('fails closed on a v3 (non-v2) sibling namespace directory', async () => {
    await writeWorkspaceManifest({ workspaceRoot: root, manifest: sampleManifest() })
    mkdirSync(join(root, 'pages', 'v3'), { recursive: true })

    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('mixed-namespace')
    if (result._tag !== 'mixed-namespace') return
    expect([...result.offendingPaths]).toEqual(['pages/v3'])
  })

  it('does not flag the v1 namespace directories as mixed', async () => {
    await writeWorkspaceManifest({ workspaceRoot: root, manifest: sampleManifest() })
    mkdirSync(join(root, 'data', 'v1'), { recursive: true })
    mkdirSync(join(root, 'pages', 'v1'), { recursive: true })
    mkdirSync(join(root, '.notion', 'v1'), { recursive: true })

    expect(loadWorkspaceManifest(root)._tag).toBe('tracked')
  })

  it('accepts a linked view that references a tracked data source (read-only projection)', () => {
    const manifest = decode(WorkspaceManifestV1, {
      ...sampleManifest(),
      linked_views: [
        {
          name: 'tasks-board',
          view_id: 'view-1',
          data_source_id: 'data-source-1',
          mode: 'projection',
        },
      ],
    })
    writeFileSync(manifestPath(root), JSON.stringify(manifest))

    expect(loadWorkspaceManifest(root)._tag).toBe('tracked')
  })

  it('fails closed (R08) on a linked view referencing an untracked data source', () => {
    const manifest = decode(WorkspaceManifestV1, {
      ...sampleManifest(),
      linked_views: [
        {
          name: 'orphan-board',
          view_id: 'view-9',
          data_source_id: 'data-source-unknown',
          mode: 'projection',
        },
      ],
    })
    writeFileSync(manifestPath(root), JSON.stringify(manifest))

    const result = loadWorkspaceManifest(root)
    expect(result._tag).toBe('invalid-linked-view')
    if (result._tag !== 'invalid-linked-view') return
    expect(result.offendingViews).toEqual(['orphan-board'])
  })
})
