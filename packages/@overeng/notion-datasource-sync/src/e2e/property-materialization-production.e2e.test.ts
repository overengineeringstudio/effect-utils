/**
 * SM5d genuine-production proof: a datasource pull MATERIALIZES the page's
 * writable frontmatter properties into its `pages/v1/<source>/*.nmd`, through the
 * REAL pipeline — `observeRemoteDataSource` observes the row's inline property
 * values, builds the `MaterializePlan.writableProperties` from them
 * (`writableFrontmatterProperties`), and the NotionMD-materializing workspace port
 * writes them via `materializeBody`. NOT a hand-authored `.nmd`.
 *
 * This is what makes local-surface convergence (SM5c) ACTIVE in production: before
 * SM5d the pulled `.nmd` carried `properties: {}` and convergence was inert.
 *
 * The load-bearing invariants:
 * - the materialized `.nmd` carries the writable property (and ONLY writable ones);
 * - round-trip fidelity: the materialized value re-hashes to the SAME convergence
 *   space the cell's `convergence_hash` lives in (so an unedited `.nmd` never
 *   false-diverges against the cell it was materialized from);
 * - a frontmatter property edit changes the whole-file content hash, so the scan
 *   reports the page as a genuine local edit (dirty), NOT an own-write — the
 *   convergence/conflict path can then catch it instead of a silent clobber.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { NodeContext } from '@effect/platform-node'
import { Chunk, Effect, Layer, Stream } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import { parseNmdFile } from '@overeng/notion-md'
import {
  NmdStateStore,
  NmdStateStoreLive,
  type NotionMdGatewayShape,
  type PullPageResult,
} from '@overeng/notion-md'

import { bodySafetySnapshot, makeFakePageBodySyncPort } from '../body/adapter.ts'
import { makeNotionMdMaterializingLocalWorkspacePort } from '../body/notion-md.ts'
import {
  AbsolutePath,
  BodyPointer,
  DataSourceId,
  DataSourceSnapshot,
  NotionRequestId,
  PageId,
  PropertyId,
  bodyDescriptorForDigest,
  bodyEvidenceFingerprintFromContentDigest,
  evidenceBackedBodyIdentity,
  type AbsolutePath as AbsolutePathType,
} from '../core/domain.ts'
import { SyncRootId, type SyncEvent } from '../core/events.ts'
import { LocalWorkspacePort, NotionDataSourceGateway, PageBodySyncPort } from '../core/ports.ts'
import { pagesDirRelativePath } from '../local/manifest.ts'
import { bodyPathForRowInDir } from '../local/workspace.ts'
import { convergeLocalSurfaces } from '../planner/local-convergence.ts'
import { projectReplicaFromSyncStore, readReplicaCellBases } from '../replica/replica.ts'
import {
  buildPropertyConvergenceInputs,
  scanNmdPageSurfaces,
} from '../sync/local-convergence-inputs.ts'
import { observeRemoteDataSource } from '../sync/observation.ts'
import {
  decode,
  defaultQueryContract,
  fixedObservedAt,
  hash,
  makeFakeGatewayHarness,
  makeStoreFixture,
  pageSnapshot,
} from '../testing/harness.ts'

const scratchDirs: string[] = []

// NotionMD's frontmatter `page_id` is a `NotionUUID`, so the materialize path
// requires real UUIDs end-to-end.
const pageUuid = decode({ schema: PageId, value: '11111111-1111-4111-8111-111111111111' })
const dataSourceUuid = decode({
  schema: DataSourceId,
  value: '22222222-2222-4222-8222-222222222222',
})
const rootId = decode({ schema: SyncRootId, value: 'root-sm5d' })
const selectProp = decode({ schema: PropertyId, value: 'p-priority' })
const titleProp = decode({ schema: PropertyId, value: 'p-title' })
const readOnlyProp = decode({ schema: PropertyId, value: 'p-formula' })

const selectName = 'Priority'
const titleName = 'Name'
const readOnlyName = 'Computed'

const markdown = '# Materialized page\n\nBody pulled through NotionMD.\n'

/** Full canonical select value (id+color), exactly as a remote observation produces. */
const remoteSelectJson = (name: string): string =>
  JSON.stringify({
    _tag: 'select',
    option: { _tag: 'CanonicalOptionValue', id: `opt-${name}`, name, color: 'blue' },
  })
const titleJson = (text: string): string => JSON.stringify({ _tag: 'title', plainText: text })
const readOnlyJson = (text: string): string =>
  JSON.stringify({ _tag: 'rich_text', plainText: text })

const tempRoot = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm5d-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

/** A body pointer for the SM5d page, so `observeRemoteDataSource` can materialize it. */
const bodyPointerForPage = () =>
  decode({
    schema: BodyPointer,
    value: {
      _tag: 'BodyPointer',
      pageId: pageUuid,
      identity: evidenceBackedBodyIdentity({
        rendered: bodyDescriptorForDigest(hash('sm5d-body')),
        evidenceFingerprint: bodyEvidenceFingerprintFromContentDigest(hash('sm5d-body')),
        completeness: 'complete',
      }),
      observedAt: '2026-06-15T00:00:00.000Z',
      safety: bodySafetySnapshot(),
    },
  })

const bodyPort = () =>
  makeFakePageBodySyncPort({
    pages: [
      {
        pageId: pageUuid,
        pointer: bodyPointerForPage(),
        requestId: decode({ schema: NotionRequestId, value: 'req-sm5d' }),
      },
    ],
  })

/** The `.nmd` path under the source's `pages/v1/<source>` dir (where convergence scans). */
const bodyPathForPageInSource = () => {
  const decision = bodyPathForRowInDir({
    pagesDir: pagesDirRelativePath(dataSourceUuid),
    title: 'Materialized page',
    pageId: pageUuid,
  })
  if (decision._tag !== 'allowed') throw new Error('expected an allowed body path')
  return decision.path
}

const pullPageResult = (): PullPageResult => ({
  page: {
    id: pageUuid,
    title: 'Materialized page',
    title_property_key: titleName,
    url: undefined,
    parent: { type: 'data_source_id', data_source_id: dataSourceUuid },
    icon: null,
    cover: null,
    in_trash: false,
    is_locked: false,
    last_edited_time: '2026-06-15T00:00:00.000Z',
    // notion-md does NOT decide the writable set; datasource-sync injects it.
    properties: {},
  },
  markdown: {
    markdown,
    truncated: false,
    unknown_block_ids: [],
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
})

const fakeNotionMdGateway = (): NotionMdGatewayShape => ({
  pullPage: () => Effect.succeed(pullPageResult()),
  updateMarkdown: () => Effect.die('updateMarkdown not expected'),
  updatePageProperties: () => Effect.die('updatePageProperties not expected'),
  updatePageMetadata: () => Effect.die('updatePageMetadata not expected'),
  retrieveDataSource: () => Effect.die('retrieveDataSource not expected'),
  listChildPages: () => Effect.succeed([]),
  createPage: () => Effect.die('createPage not expected'),
  movePage: () => Effect.die('movePage not expected'),
  archivePage: () => Effect.die('archivePage not expected'),
})

/** Data-source snapshot bound to the SM5d UUID with the writable + read-only schema. */
const dataSourceSnapshot = (): DataSourceSnapshot =>
  decode({
    schema: DataSourceSnapshot,
    value: {
      _tag: 'DataSourceSnapshot',
      dataSourceId: dataSourceUuid,
      parentDatabaseId: '33333333-3333-4333-8333-333333333333',
      requestId: 'req-sm5d',
      observedAt: fixedObservedAt,
      schemaHash: hash('schema-sm5d'),
      schemaProperties: [
        {
          _tag: 'DataSourcePropertySnapshot',
          propertyId: titleProp,
          name: titleName,
          type: 'title',
          configHash: hash('c-title'),
          writeClass: 'writable',
          ordinal: 0,
          configJson: JSON.stringify({ type: 'title' }),
        },
        {
          _tag: 'DataSourcePropertySnapshot',
          propertyId: selectProp,
          name: selectName,
          type: 'select',
          configHash: hash('c-select'),
          writeClass: 'writable',
          ordinal: 1,
          configJson: JSON.stringify({ type: 'select' }),
        },
        {
          _tag: 'DataSourcePropertySnapshot',
          propertyId: readOnlyProp,
          name: readOnlyName,
          type: 'rich_text',
          configHash: hash('c-formula'),
          writeClass: 'computed',
          ordinal: 2,
          configJson: JSON.stringify({ type: 'rich_text' }),
        },
      ],
      metadataHash: hash('metadata-sm5d'),
      metadataJson: JSON.stringify({
        _tag: 'CanonicalDataSourceMetadata',
        titlePlainText: 'SM5d data source',
        descriptionPlainText: 'SM5d',
        icon: { _tag: 'none' },
      }),
      metadataTitlePlainText: 'SM5d data source',
      metadataDescriptionPlainText: 'SM5d',
    },
  })

/**
 * Drive the REAL `observeRemoteDataSource` with a row carrying inline property
 * values and the NotionMD-materializing workspace port. Returns the materialized
 * `.nmd` path AND the observe events (so a caller can project a real replica with
 * the actual `convergence_hash`, not a hand-built one).
 */
const observeAndMaterialize = async ({
  root,
  selectValue,
  materializeBodyArtifacts = true,
}: {
  readonly root: AbsolutePathType
  readonly selectValue: string
  /**
   * Mirror the orchestration gate: the full-sync flow passes `false` when the
   * local workspace has un-synced edits, so the pull does NOT re-materialize and
   * clobber them (sync.ts: `localWorkspaceChanged === true` → `materializeBodyArtifacts: false`).
   */
  readonly materializeBodyArtifacts?: boolean
}): Promise<{ readonly nmdPath: string; readonly events: ReadonlyArray<SyncEvent> }> => {
  const gatewayHarness = makeFakeGatewayHarness({
    dataSource: dataSourceSnapshot(),
    pages: [
      pageSnapshot({
        pageId: pageUuid,
        dataSourceId: dataSourceUuid,
        propertyValuesJson: {
          [titleProp]: titleJson('Materialized page'),
          [selectProp]: remoteSelectJson(selectValue),
          [readOnlyProp]: readOnlyJson('derived'),
        },
      }),
    ],
  })

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const stateStore = yield* NmdStateStore
      const workspace = makeNotionMdMaterializingLocalWorkspacePort({
        root,
        gateway: fakeNotionMdGateway(),
        stateStore,
      })
      return yield* observeRemoteDataSource({
        rootId,
        dataSourceId: dataSourceUuid,
        workspaceRoot: root,
        queryContract: defaultQueryContract(),
        // Intentionally NO `schemaProperties` override: the observe pass derives the
        // schema (incl. write_class) from the data-source snapshot AND takes the
        // inline-value path, emitting `PagePropertyCheckpointRecorded` so the
        // projected replica carries real per-cell `convergence_hash`.
        materializeBodies: true,
        materializeBodyArtifacts,
        // Materialize INTO the source's `pages/v1/<source>` dir — the directory the
        // convergence scanner (`scanNmdPageSurfaces`) reads — exactly as the CLI does.
        bodyPathForPage: () => bodyPathForPageInSource(),
        now: () => new Date('2026-06-15T00:00:00.000Z'),
      }).pipe(
        Effect.provideService(NotionDataSourceGateway, gatewayHarness.gateway),
        Effect.provideService(PageBodySyncPort, bodyPort()),
        Effect.provideService(LocalWorkspacePort, workspace),
      )
    }).pipe(Effect.provide(NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)))),
  )

  return { nmdPath: join(root, bodyPathForPageInSource()), events: result.events }
}

/**
 * Project a real replica from the observe events and return the per-cell bases —
 * this populates `_nds_replica_cells.convergence_hash` from the actual
 * `PagePropertyCheckpointRecorded` events, NOT a hand-built hash.
 */
const projectAndReadBases = (events: ReadonlyArray<SyncEvent>, root: AbsolutePathType) => {
  const fixture = makeStoreFixture({ mode: 'file' })
  const replicaPath = join(root, 'replica.sqlite')
  try {
    for (const event of events) fixture.store.appendEvent(event)
    projectReplicaFromSyncStore({ syncStorePath: fixture.path, replicaPath, rootId })
    return readReplicaCellBases(replicaPath)
  } finally {
    fixture.cleanup()
  }
}

describe('SM5d property materialization (real pull → materialized .nmd frontmatter)', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('materializes WRITABLE frontmatter properties (and only writable) into the pulled .nmd', async () => {
    const root = await tempRoot()
    const { nmdPath } = await observeAndMaterialize({ root, selectValue: 'High' })

    const content = await readFile(nmdPath, 'utf8')
    const parsed = await Effect.runPromise(parseNmdFile({ content, path: nmdPath }))
    const properties = parsed.frontmatter.notion_md.properties

    // Writable scalar properties are present, name-only (select carries no id/color).
    expect(properties[selectName]).toEqual({ _tag: 'select', value: 'High' })
    expect(properties[titleName]).toEqual({ _tag: 'title', value: 'Materialized page' })
    // The read-only property is NOT in the editable frontmatter.
    expect(properties[readOnlyName]).toBeUndefined()
  })

  it('KEYSTONE: an UNEDITED materialized .nmd does NOT false-diverge against the projected replica', async () => {
    // The load-bearing regression guard for the whole SM5c+SM5d edifice: run the
    // REAL observe→materialize→project→scan→converge pipeline. The base is the
    // ACTUAL `_nds_replica_cells.convergence_hash` (projected from the observe
    // events), NOT a hand-built hash. A freshly materialized `.nmd` (no local
    // edits) must produce ZERO `nmdFacts` and `converged` verdicts — otherwise
    // materialization false-diverges every property on every page.
    const root = await tempRoot()
    const { nmdPath, events } = await observeAndMaterialize({ root, selectValue: 'High' })

    const bases = projectAndReadBases(events, root)
    // The select cell was projected with a real convergence_hash.
    expect(bases.some((b) => b.propertyName === selectName)).toBe(true)

    const surfaces = scanNmdPageSurfaces({
      workspaceRoot: root,
      pagesDir: pagesDirRelativePath(dataSourceUuid),
    })
    expect(surfaces.some((s) => s.pageId === pageUuid)).toBe(true)

    const { dataFileEdits, nmdFacts } = buildPropertyConvergenceInputs({
      workspaceRoot: root,
      pagesDir: pagesDirRelativePath(dataSourceUuid),
      changes: [],
      bases,
    })
    // The crux: no SQLite edits, and the unedited materialized `.nmd` diffs equal
    // against the projected convergence_hash → no facts → nothing to converge.
    expect(nmdFacts).toHaveLength(0)

    const result = convergeLocalSurfaces({ authorityMode: 'shared', dataFileEdits, nmdFacts })
    expect(result._tag).toBe('shared')
    if (result._tag !== 'shared') return
    expect(result.conflicts).toHaveLength(0)
    expect(result.blockedIdentities).toHaveLength(0)
    // sanity: the file we scanned is the materialized one.
    expect(nmdPath).toContain(pagesDirRelativePath(dataSourceUuid))
  })

  it('DIVERGE: editing the materialized .nmd ≠ a SQLite edit yields a `disagrees` verdict', async () => {
    // (c) on the REAL materialized surface: edit the materialized `.nmd` property to
    // a value DIFFERENT from a concurrent SQLite `pages` edit → the convergence
    // engine reports `disagrees`. (SM5c already proves `disagrees` → `_nds_guard_block`
    // `LocalSurfaceDisagreement`, so engine-level divergence is sufficient here.)
    const root = await tempRoot()
    const { nmdPath, events } = await observeAndMaterialize({ root, selectValue: 'High' })
    const bases = projectAndReadBases(events, root)
    const selectBase = bases.find((b) => b.propertyName === selectName)!

    // Edit the materialized `.nmd` select to 'Low'.
    const content = await readFile(nmdPath, 'utf8')
    await writeFile(nmdPath, content.replace('"value": "High"', '"value": "Low"'), 'utf8')

    // A concurrent SQLite `pages` edit to a DIFFERENT value ('Medium').
    const sqliteEditChange = {
      changeId: 'edit-1',
      kind: 'cell_patch' as const,
      dataSourceId: dataSourceUuid as string,
      pageId: pageUuid as string,
      propertyId: selectBase.propertyId,
      valueJson: JSON.stringify({
        _tag: 'select',
        option: { _tag: 'CanonicalOptionValue', name: 'Medium' },
      }),
      baseHash: undefined,
      status: 'pending' as const,
      bodyPath: undefined,
      localBodyHash: undefined,
      localBodyContent: undefined,
      metadataResourceType: undefined,
      databaseId: undefined,
      titlePlainText: undefined,
      descriptionPlainText: undefined,
      schemaOperationJson: undefined,
      fileAssetId: undefined,
      fileAction: undefined,
      fileName: undefined,
      fileExternalUrl: undefined,
      conflictId: undefined,
      resolutionAction: undefined,
      localRowId: undefined,
      clientRequestKey: undefined,
      remotePageId: undefined,
    }

    const { dataFileEdits, nmdFacts } = buildPropertyConvergenceInputs({
      workspaceRoot: root,
      pagesDir: pagesDirRelativePath(dataSourceUuid),
      changes: [sqliteEditChange] as never,
      bases,
    })
    // Both surfaces produced a fact/edit for the select identity, with DIFFERENT values.
    expect(nmdFacts).toHaveLength(1)
    expect(dataFileEdits.length).toBeGreaterThanOrEqual(1)

    const result = convergeLocalSurfaces({ authorityMode: 'shared', dataFileEdits, nmdFacts })
    expect(result._tag).toBe('shared')
    if (result._tag !== 'shared') return
    expect(result.propertyVerdicts).toContainEqual({
      pageId: pageUuid,
      propertyId: selectBase.propertyId,
      status: 'disagrees',
    })
  })

  it('uses the pages/v1/<source> directory the convergence scanner reads', async () => {
    const root = await tempRoot()
    const { nmdPath } = await observeAndMaterialize({ root, selectValue: 'High' })
    // The materialized path lives under the convergence scanner's pages dir.
    expect(nmdPath).toContain(join('pages', 'v1', dataSourceUuid))
    expect(pagesDirRelativePath(dataSourceUuid)).toBe(join('pages', 'v1', dataSourceUuid))
  })

  it('a frontmatter property edit is observed as a genuine local edit (dirty, not own-write)', async () => {
    const root = await tempRoot()
    const { nmdPath } = await observeAndMaterialize({ root, selectValue: 'High' })

    // Edit ONLY the frontmatter property (not the body).
    const content = await readFile(nmdPath, 'utf8')
    await writeFile(nmdPath, content.replace('"value": "High"', '"value": "Low"'), 'utf8')

    const observations = await Effect.runPromise(
      Effect.gen(function* () {
        const stateStore = yield* NmdStateStore
        const workspace = makeNotionMdMaterializingLocalWorkspacePort({
          root,
          gateway: fakeNotionMdGateway(),
          stateStore,
        })
        return yield* workspace
          .scan(root)
          .pipe(Stream.runCollect, Effect.map(Chunk.toReadonlyArray))
      }).pipe(Effect.provide(NmdStateStoreLive.pipe(Layer.provide(NodeContext.layer)))),
    )

    const observation = observations.find((o) => o.pageId === pageUuid)
    expect(observation).toBeDefined()
    // A frontmatter-only edit changes the whole-file content hash, so the scan must
    // NOT treat it as an own-write (suppressed); it is a genuine local edit that the
    // convergence/conflict path can then reconcile.
    expect(observation?.ownWriteSuppressionToken).toBeUndefined()
  })

  it('ROUNDTRIP (unguarded): a raw re-pull would clobber an un-synced local frontmatter edit', async () => {
    // The roundtrip caution (task): materializing properties means a re-pull rewrites
    // `.nmd` properties. The observation pass's per-row materialize is unconditional
    // (no dirty gate), so a RAW re-pull (`materializeBodyArtifacts` default true)
    // overwrites a locally-edited frontmatter property back to the remote value.
    // This is exactly WHY the orchestration gate below exists.
    const root = await tempRoot()
    const { nmdPath } = await observeAndMaterialize({ root, selectValue: 'High' })

    const edited = (await readFile(nmdPath, 'utf8')).replace('"value": "High"', '"value": "Low"')
    await writeFile(nmdPath, edited, 'utf8')

    await observeAndMaterialize({ root, selectValue: 'High' }) // raw re-pull

    const parsed = await Effect.runPromise(
      parseNmdFile({ content: await readFile(nmdPath, 'utf8'), path: nmdPath }),
    )
    // Clobbered back to the remote value — the local 'Low' edit is lost.
    expect(parsed.frontmatter.notion_md.properties[selectName]).toEqual({
      _tag: 'select',
      value: 'High',
    })
  })

  it('ROUNDTRIP (guarded): the orchestration gate (`materializeBodyArtifacts: false`) PRESERVES a dirty local edit on re-pull', async () => {
    // The end-to-end safety the spec requires ("materialization never overwrites
    // dirty local Markdown without first preserving it"): the full-sync flow detects
    // a changed local workspace and passes `materializeBodyArtifacts: false` to the
    // pull (sync.ts:914), so re-materialization is SKIPPED while local edits are
    // pending. The dirty `.nmd` edit survives until convergence/push reconciles it.
    const root = await tempRoot()
    const { nmdPath } = await observeAndMaterialize({ root, selectValue: 'High' })

    const edited = (await readFile(nmdPath, 'utf8')).replace('"value": "High"', '"value": "Low"')
    await writeFile(nmdPath, edited, 'utf8')

    // The guarded re-pull (the path taken when the local workspace has changed).
    await observeAndMaterialize({ root, selectValue: 'High', materializeBodyArtifacts: false })

    const parsed = await Effect.runPromise(
      parseNmdFile({ content: await readFile(nmdPath, 'utf8'), path: nmdPath }),
    )
    // The local 'Low' edit is PRESERVED — no clobber while it is un-synced.
    expect(parsed.frontmatter.notion_md.properties[selectName]).toEqual({
      _tag: 'select',
      value: 'Low',
    })
  })
})
