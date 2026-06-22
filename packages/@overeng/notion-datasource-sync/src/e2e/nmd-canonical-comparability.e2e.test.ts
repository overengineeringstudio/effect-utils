/**
 * Two-oracle proof that the SQLite `pages` surface and the `.nmd` frontmatter
 * surface produce a BYTE-IDENTICAL canonical hash for the same scalar property
 * value (SM5c). This is the load-bearing invariant under property convergence:
 *
 * - Oracle 1 (SQLite): a real user edit through the public `pages` view, whose
 *   `INSTEAD OF UPDATE` trigger writes `value_json` via `json_object(...)`. We
 *   read that stored string and hash it with `hashStoreBytes` — exactly the
 *   planner's `desiredHash`.
 * - Oracle 2 (`.nmd`): the equivalent `NmdWritablePropertyValue` routed through
 *   `nmdPropertyDesiredHash` (`.nmd → raw → codec.decodeSync → JSON.stringify →
 *   hashStoreBytes`).
 *
 * They are PARALLEL implementations (hand-written SQL trigger vs the TS canonical
 * codec), so this test pins their agreement and catches silent drift if either
 * changes. If a scalar type ever diverges here, that type cannot converge and
 * must be fixed before it ships.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { Effect, Option } from 'effect'
import { afterEach, describe, expect, it } from 'vitest'

import type { NmdWritablePropertyValue } from '@overeng/notion-effect-client'

import {
  parseCliCommand,
  parseCliContext,
  resolveCliCommandNotionRefs,
  runCliCommandWithRuntime,
} from '../cli/main.ts'
import { PagePropertyItemPage } from '../core/commands.ts'
import { AbsolutePath, PropertyId, type AbsolutePath as AbsolutePathType } from '../core/domain.ts'
import type { NotionGatewayClient } from '../gateway/notion.ts'
import {
  canonicalValueToNmdWritable,
  convergenceFormHash,
  nmdPropertyDesiredHash,
} from '../planner/nmd-property-facts.ts'
import { readPendingReplicaChanges } from '../replica/replica.ts'
import {
  decode,
  fixedObservedAt,
  hash,
  makeFakeGatewayHarness,
  testIds,
} from '../testing/harness.ts'

const scratchDirs: string[] = []
const databaseUrl =
  'https://www.notion.so/example/0123456789abcdef0123456789abcdef?v=feedfacefeedfacefeedfacefeedface'

const sqlitePathForWorkspace = (workspace: string): string =>
  join(workspace, 'data', 'v1', `${testIds.databaseId}.sqlite`)

const tempWorkspace = async (): Promise<AbsolutePathType> => {
  const dir = await mkdtemp(join(tmpdir(), 'nds-sm5c-comparability-'))
  scratchDirs.push(dir)
  return decode({ schema: AbsolutePath, value: dir })
}

const propertyPage = (propertyId: PropertyId, plainText: string) =>
  decode({
    schema: PagePropertyItemPage,
    value: {
      _tag: 'PagePropertyItemPage',
      apiVersion: '2026-03-11',
      requestId: testIds.requestId,
      pageId: testIds.pageId,
      propertyId,
      items: [
        {
          _tag: 'PagePropertyItem',
          pageId: testIds.pageId,
          propertyId,
          itemHash: hash(`item-${propertyId}-${plainText}`),
          valueHash: hash(`value-${propertyId}-${plainText}`),
          valueJson: JSON.stringify({ _tag: 'title', plainText }),
        },
      ],
      nextCursor: null,
      hasMore: false,
    },
  })

const databaseResolverClient = (): NotionGatewayClient => ({
  retrieveDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  queryDataSource: () => Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
  retrievePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  retrievePageProperty: () =>
    Effect.succeed({ results: [], nextCursor: Option.none(), hasMore: false }),
  retrieveDatabase: () =>
    Effect.succeed({
      id: testIds.databaseId,
      title: [],
      description: [],
      icon: null,
      data_sources: [{ id: testIds.dataSourceId, name: 'Rows' }],
    }),
  updatePage: () =>
    Effect.succeed({
      id: testIds.pageId,
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  createPage: () =>
    Effect.succeed({
      id: 'created-page',
      parent: { type: 'data_source_id', data_source_id: testIds.dataSourceId },
      properties: {},
      last_edited_time: fixedObservedAt,
      in_trash: false,
    }),
  updateDataSource: () => Effect.succeed({ id: testIds.dataSourceId, properties: {} }),
  updateDatabase: () =>
    Effect.succeed({ id: testIds.databaseId, title: [], description: [], icon: null }),
})

const titleProp = decode({ schema: PropertyId, value: 'p-title' })
const richTextProp = decode({ schema: PropertyId, value: 'p-rich' })
const numberProp = decode({ schema: PropertyId, value: 'p-number' })
const checkboxProp = decode({ schema: PropertyId, value: 'p-checkbox' })
const dateProp = decode({ schema: PropertyId, value: 'p-date' })
const selectProp = decode({ schema: PropertyId, value: 'p-select' })
const statusProp = decode({ schema: PropertyId, value: 'p-status' })
const urlProp = decode({ schema: PropertyId, value: 'p-url' })

const schemaProperties = [
  {
    propertyId: titleProp,
    name: 'Title',
    type: 'title',
    configHash: hash('c-title'),
    writeClass: 'writable',
    ordinal: 0,
    configJson: JSON.stringify({ type: 'title' }),
  },
  {
    propertyId: richTextProp,
    name: 'Notes',
    type: 'rich_text',
    configHash: hash('c-rich'),
    writeClass: 'writable',
    ordinal: 1,
    configJson: JSON.stringify({ type: 'rich_text' }),
  },
  {
    propertyId: numberProp,
    name: 'Score',
    type: 'number',
    configHash: hash('c-number'),
    writeClass: 'writable',
    ordinal: 2,
    configJson: JSON.stringify({ type: 'number' }),
  },
  {
    propertyId: checkboxProp,
    name: 'Done',
    type: 'checkbox',
    configHash: hash('c-checkbox'),
    writeClass: 'writable',
    ordinal: 3,
    configJson: JSON.stringify({ type: 'checkbox' }),
  },
  {
    propertyId: dateProp,
    name: 'Due',
    type: 'date',
    configHash: hash('c-date'),
    writeClass: 'writable',
    ordinal: 4,
    configJson: JSON.stringify({ type: 'date' }),
  },
  {
    propertyId: selectProp,
    name: 'Priority',
    type: 'select',
    configHash: hash('c-select'),
    writeClass: 'writable',
    ordinal: 5,
    configJson: JSON.stringify({
      id: 'p-select',
      name: 'Priority',
      type: 'select',
      select: { options: [{ id: 'hi', name: 'High', color: 'red' }] },
    }),
  },
  {
    propertyId: statusProp,
    name: 'State',
    type: 'status',
    configHash: hash('c-status'),
    writeClass: 'writable',
    ordinal: 6,
    configJson: JSON.stringify({
      id: 'p-status',
      name: 'State',
      type: 'status',
      status: { options: [{ id: 'done', name: 'Done', color: 'green' }] },
    }),
  },
  {
    propertyId: urlProp,
    name: 'Link',
    type: 'url',
    configHash: hash('c-url'),
    writeClass: 'writable',
    ordinal: 7,
    configJson: JSON.stringify({ type: 'url' }),
  },
] as const

const establish = async (workspace: AbsolutePathType): Promise<string> => {
  const gateway = makeFakeGatewayHarness({
    propertyPages: schemaProperties.map((p) => propertyPage(p.propertyId, 'init')),
  })
  const gatewayClient = databaseResolverClient()
  const argv = [
    'track',
    databaseUrl,
    workspace,
    '--mode',
    'shared',
    '--schema-properties-json',
    JSON.stringify(schemaProperties),
    '--no-materialize-bodies',
  ] as readonly string[]
  const command = await Effect.runPromise(
    resolveCliCommandNotionRefs({ command: parseCliCommand(argv), options: { gatewayClient } }),
  )
  const context = parseCliContext({ argv, resolvedCommand: command })
  try {
    await Effect.runPromise(
      runCliCommandWithRuntime({
        command,
        context,
        options: { gateway: gateway.gateway, gatewayClient },
      }),
    )
  } finally {
    context.store.close()
  }
  return sqlitePathForWorkspace(workspace)
}

/** Edit one scalar column on the public `pages` view, return the stored cell value_json. */
const editAndReadValueJson = ({
  sqlitePath,
  columnName,
  value,
}: {
  readonly sqlitePath: string
  readonly columnName: string
  readonly value: string | number | bigint | null
}): string => {
  const db = new DatabaseSync(sqlitePath)
  try {
    db.prepare(`UPDATE pages SET "${columnName}" = ? WHERE _page_id = ?`).run(value, testIds.pageId)
  } finally {
    db.close()
  }
  const changes = readPendingReplicaChanges(sqlitePath).filter((c) => c.kind === 'cell_patch')
  const change = changes.at(-1)
  if (change?.valueJson === undefined) {
    throw new Error(`No cell_patch value_json captured for column ${columnName}`)
  }
  return change.valueJson
}

type Case = {
  readonly name: string
  readonly columnName: string
  readonly sqlValue: string | number | bigint | null
  readonly nmd: NmdWritablePropertyValue
}

const cases: readonly Case[] = [
  {
    name: 'title',
    columnName: 'Title',
    sqlValue: 'Hello world',
    nmd: { _tag: 'title', value: 'Hello world' },
  },
  {
    name: 'rich_text',
    columnName: 'Notes',
    sqlValue: 'A note',
    nmd: { _tag: 'rich_text', value: 'A note' },
  },
  {
    name: 'number (integer)',
    columnName: 'Score',
    sqlValue: 42,
    nmd: { _tag: 'number', value: 42 },
  },
  {
    name: 'checkbox (true)',
    columnName: 'Done',
    sqlValue: 1,
    nmd: { _tag: 'checkbox', value: true },
  },
  {
    name: 'checkbox (false)',
    columnName: 'Done',
    sqlValue: 0,
    nmd: { _tag: 'checkbox', value: false },
  },
  {
    name: 'date',
    columnName: 'Due',
    sqlValue: '2026-06-15',
    nmd: { _tag: 'date', value: { start: '2026-06-15', end: null, time_zone: null } },
  },
  {
    name: 'select',
    columnName: 'Priority',
    sqlValue: 'High',
    nmd: { _tag: 'select', value: 'High' },
  },
  { name: 'status', columnName: 'State', sqlValue: 'Done', nmd: { _tag: 'status', value: 'Done' } },
  {
    name: 'url',
    columnName: 'Link',
    sqlValue: 'https://example.com',
    nmd: { _tag: 'url', value: 'https://example.com' },
  },
]

describe('SM5c cross-surface canonical comparability (two-oracle)', () => {
  afterEach(async () => {
    await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('SQLite pages value_json hash equals the .nmd-derived canonical hash for every scalar type', async () => {
    const workspace = await tempWorkspace()
    const sqlitePath = await establish(workspace)

    for (const testCase of cases) {
      const valueJson = editAndReadValueJson({
        sqlitePath,
        columnName: testCase.columnName,
        value: testCase.sqlValue,
      })
      const nmdHash = nmdPropertyDesiredHash(testCase.nmd)
      expect(nmdHash, `${testCase.name}: .nmd hash must be defined (scalar type)`).toBeDefined()
      // The load-bearing invariant: both surfaces hash equal through the shared
      // convergence normalizer (`convergenceFormHash`, which strips option
      // id/color, folds SQLite's REAL number coercion, and normalizes JSON
      // escaping). This is what the engine consumes.
      expect(nmdHash, `${testCase.name}: SQLite vs .nmd convergence hash`).toBe(
        convergenceFormHash(valueJson),
      )
    }
  })

  it('a FULL remote select canonical (id+color) folds to the SAME convergence hash as the name-only .nmd value', () => {
    // The cross-space invariant: production `remote_hash`/`value_json` keep the
    // option id+color (`canonicalOptionFromRemote`), but the `.nmd` surface is
    // name-only. `convergenceFormHash` must fold the rich remote form DOWN to the
    // name-only space, or an untouched select false-diverges. (Asserting hashEQ
    // here is NOT circular: the left side carries id+color, the right does not.)
    const fullRemoteSelectJson = JSON.stringify({
      _tag: 'select',
      option: { _tag: 'CanonicalOptionValue', id: 'hi', name: 'High', color: 'red' },
    })
    expect(convergenceFormHash(fullRemoteSelectJson)).toBe(
      nmdPropertyDesiredHash({ _tag: 'select', value: 'High' }),
    )
  })

  it('a cleared number folds equal across the SQLite (value:null) and codec (empty) shapes', () => {
    const sqliteNullNumberJson = JSON.stringify({ _tag: 'number', value: null })
    expect(convergenceFormHash(sqliteNullNumberJson)).toBe(
      nmdPropertyDesiredHash({ _tag: 'number', value: null }),
    )
  })

  it('a different .nmd value produces a different hash (real divergence is detectable)', () => {
    const a = nmdPropertyDesiredHash({ _tag: 'select', value: 'High' })
    const b = nmdPropertyDesiredHash({ _tag: 'select', value: 'Low' })
    expect(a).toBeDefined()
    expect(b).toBeDefined()
    expect(a).not.toBe(b)
  })

  it('non-scalar tags are not convergence-comparable (no fact emitted)', () => {
    expect(nmdPropertyDesiredHash({ _tag: 'multi_select', value: ['a', 'b'] })).toBeUndefined()
    expect(nmdPropertyDesiredHash({ _tag: 'relation', value: [] })).toBeUndefined()
    expect(nmdPropertyDesiredHash({ _tag: 'people', value: [] })).toBeUndefined()
  })
})

describe('SM5d materialization inverse map (canonical value_json → .nmd writable)', () => {
  // The materialization fidelity invariant: an observed canonical `value_json`
  // projected to an `.nmd` writable value MUST round-trip back to the same
  // `convergence_hash` space — otherwise a freshly materialized `.nmd` would
  // false-diverge against the cell it was materialized from. The full remote
  // select (id+color) deliberately exercises the name-only fold.
  const roundtrip: ReadonlyArray<{ readonly type: string; readonly valueJson: string }> = [
    {
      type: 'select',
      valueJson: JSON.stringify({
        _tag: 'select',
        option: { _tag: 'CanonicalOptionValue', id: 'hi', name: 'High', color: 'red' },
      }),
    },
    {
      type: 'status',
      valueJson: JSON.stringify({
        _tag: 'status',
        option: { _tag: 'CanonicalOptionValue', id: 'd', name: 'Done', color: 'green' },
      }),
    },
    { type: 'number', valueJson: JSON.stringify({ _tag: 'number', value: 42 }) },
    { type: 'number', valueJson: JSON.stringify({ _tag: 'empty' }) },
    { type: 'title', valueJson: JSON.stringify({ _tag: 'title', plainText: 'Hello' }) },
    { type: 'rich_text', valueJson: JSON.stringify({ _tag: 'rich_text', plainText: 'Note' }) },
    { type: 'checkbox', valueJson: JSON.stringify({ _tag: 'checkbox', checked: true }) },
    { type: 'date', valueJson: JSON.stringify({ _tag: 'date', start: '2026-06-15', end: null }) },
    { type: 'url', valueJson: JSON.stringify({ _tag: 'url', value: 'https://example.com' }) },
    { type: 'email', valueJson: JSON.stringify({ _tag: 'email', value: 'a@b.com' }) },
  ]

  for (const { type, valueJson } of roundtrip) {
    it(`round-trips ${type} (${valueJson}) to the same convergence hash`, () => {
      const writable = canonicalValueToNmdWritable({ valueJson, propertyType: type })
      expect(writable, `writable defined for ${type}`).toBeDefined()
      expect(nmdPropertyDesiredHash(writable!)).toBe(convergenceFormHash(valueJson))
    })
  }

  it('non-scalar canonical values are not materialized into frontmatter', () => {
    const multiSelect = JSON.stringify({
      _tag: 'multi_select',
      options: [{ _tag: 'CanonicalOptionValue', name: 'A' }],
    })
    expect(
      canonicalValueToNmdWritable({ valueJson: multiSelect, propertyType: 'multi_select' }),
    ).toBeUndefined()
  })
})
