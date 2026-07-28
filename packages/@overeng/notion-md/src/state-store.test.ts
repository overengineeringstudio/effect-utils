import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { Path } from 'effect'
import { NodeServices } from '@effect/platform-node'
import { Effect, Layer, Schema } from 'effect'
import { describe, expect, it } from 'vitest'

import {
  makeNmdObjectRef,
  nmdObjectRelativePath,
  NmdSyncStateV1Schema,
  type NmdSyncStateV1,
} from '@overeng/notion-effect-client'

import { readAllSyncStates } from './cli-program.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'
import type { NmdStateStore } from './state-store.ts'
import {
  NmdBaseSnapshotV2,
  garbageCollectObjects,
  isSafeRelativePath,
  NmdStorageObjectV2,
  NmdStateStoreLive,
  objectPath,
  writeBaseSnapshot,
  writeSyncState,
} from './state-store.ts'
import { TreeIndex } from './tree-index.ts'

const withPath = async <A>(fn: (path: Path.Path) => A): Promise<A> =>
  Effect.runPromise(Path.Path.pipe(Effect.map(fn), Effect.provide(NodeServices.layer)))

describe('notion-md state store path safety', () => {
  it('accepts content-addressed object paths under the local metadata root', async () => {
    await expect(
      withPath((path) =>
        isSafeRelativePath({
          path,
          relativePath: nmdObjectRelativePath(`sha256:${'a'.repeat(64)}`),
        }),
      ),
    ).resolves.toBe(true)
  })

  it('rejects traversal and absolute object paths', async () => {
    await expect(
      withPath((path) => [
        isSafeRelativePath({ path, relativePath: '..' }),
        isSafeRelativePath({ path, relativePath: '../outside.json' }),
        isSafeRelativePath({ path, relativePath: '.notion-md/../../outside.json' }),
        isSafeRelativePath({ path, relativePath: '/tmp/outside.json' }),
      ]),
    ).resolves.toEqual([false, false, false, false])
  })
})

const stateStoreLayer = NmdStateStoreLive.pipe(Layer.provide(NodeServices.layer))

const runStore = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext | NmdStateStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(stateStoreLayer, NodeServices.layer))))

const withTempDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), 'notion-md-state-store-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const syncStateFor = (opts: {
  readonly pageId: string
  readonly body: string
  readonly base: NmdSyncStateV1['body']['base']
}): NmdSyncStateV1 => ({
  version: 1,
  page_id: opts.pageId,
  body: {
    format: 'notion-enhanced-markdown',
    hash: sha256Digest(normalizeMarkdownLineEndings(opts.body)),
    base: opts.base,
    last_pulled_at: '2026-05-22T12:00:00.000Z',
    remote_last_edited_time: '2026-05-22T12:00:00.000Z',
    truncated: false,
    unknown_block_ids: [],
  },
  storage: { _tag: 'self_contained', unsupported_blocks: [], files: [], comments: [] },
  read_only_properties: {},
  data_source: null,
})

const encodeJson = <A, I>(schema: Schema.Schema<A, I, never>, value: A): string =>
  Schema.encodeSync(Schema.parseJson(schema, { space: 2 }))(value)

const decodeJson = <A, I>(schema: Schema.Schema<A, I, never>, encoded: string): A =>
  Schema.decodeUnknownSync(Schema.parseJson(schema), {
    errors: 'all',
    onExcessProperty: 'error',
  } as const)(encoded)

const canonicalFileJson = <A, I>(schema: Schema.Schema<A, I, never>, value: A): string =>
  `${encodeJson(schema, value).trimEnd()}\n`

const roundTripFileJson = <A, I>(schema: Schema.Schema<A, I, never>, value: A) => {
  const encoded = canonicalFileJson(schema, value)
  const decoded = decodeJson(schema, encoded)
  const reencoded = canonicalFileJson(schema, decoded)

  return {
    encoded,
    decoded,
    reencoded,
    byteIdentical: reencoded === encoded,
  }
}

const decodeFailure = <A, I>(schema: Schema.Schema<A, I, never>, encoded: string) => {
  try {
    return { _tag: 'decoded' as const, value: decodeJson(schema, encoded) }
  } catch (error) {
    return {
      _tag: 'failed' as const,
      error: error instanceof Error ? String(error) : String(error),
    }
  }
}

describe('notion-md wire baselines (cross-major invariant)', () => {
  // TODO(live-migration:effect-3-4): Effect 4 reassigns Schema.Date and renders SchemaError(...); preserve ISO state bytes and adjudicate internal failure text before re-baselining.
  it('captures state-store sync state JSON bytes and failure partition', () => {
    const baseContent = 'Base body\r\nunicode ß\n'
    const storageContent = '{"comments":["c-1"],"note":"Grüße 東京"}\n'
    const syncState: NmdSyncStateV1 = {
      version: 1,
      page_id: '00000000-0000-4000-8000-000000000101',
      body: {
        format: 'notion-enhanced-markdown',
        hash: sha256Digest(normalizeMarkdownLineEndings(baseContent)),
        base: makeNmdObjectRef({
          role: 'base_snapshot',
          hash: sha256Digest(baseContent),
          content: baseContent,
        }),
        last_pulled_at: '2026-07-28T10:15:00.000Z',
        remote_last_edited_time: '9999-12-31T23:59:59.999Z',
        truncated: false,
        unknown_block_ids: ['00000000-0000-4000-8000-000000000102'],
      },
      storage: {
        _tag: 'object_store',
        object: makeNmdObjectRef({
          role: 'storage_payload',
          hash: sha256Digest(storageContent),
          content: storageContent,
        }),
        unsupported_block_ids: ['00000000-0000-4000-8000-000000000103'],
        file_ids: ['', 'file-ß'],
        comment_ids: ['comment\r\none'],
      },
      read_only_properties: {
        '': { property_type: 'rich_text', value: null },
        'Number ß': { property_type: 'number', value: 0 },
        Formula: { property_type: 'formula', value: { _tag: 'string', value: 'line\r\nbreak' } },
      },
      data_source: {
        database_id: '00000000-0000-4000-8000-000000000104',
        data_source_id: '00000000-0000-4000-8000-000000000105',
        schema_hash: sha256Digest('schema ß\n'),
        title_property: '',
        property_ids: {
          Name: 'title',
          'Unicode ß': 'prop_ß',
        },
        read_only_properties: ['Created time', 'Last edited\r\ntime'],
      },
    }

    expect(roundTripFileJson(NmdSyncStateV1Schema, syncState)).toMatchInlineSnapshot(`
      {
        "byteIdentical": true,
        "decoded": {
          "body": {
            "base": {
              "_tag": "object_ref",
              "byte_length": 22,
              "hash": "sha256:223f7565d00d6d334aee03cb9228f6b050038cb08a992d8327718a273e9eee3f",
              "media_type": "application/json",
              "path": ".notion-md/objects/sha256/22/3f7565d00d6d334aee03cb9228f6b050038cb08a992d8327718a273e9eee3f.json",
              "role": "base_snapshot",
            },
            "format": "notion-enhanced-markdown",
            "hash": "sha256:631c4d09660eb980fabc42849c3ff762f13df107656f99ab24b560065dd3f9e9",
            "last_pulled_at": "2026-07-28T10:15:00.000Z",
            "remote_last_edited_time": "9999-12-31T23:59:59.999Z",
            "truncated": false,
            "unknown_block_ids": [
              "00000000-0000-4000-8000-000000000102",
            ],
          },
          "data_source": {
            "data_source_id": "00000000-0000-4000-8000-000000000105",
            "database_id": "00000000-0000-4000-8000-000000000104",
            "property_ids": {
              "Name": "title",
              "Unicode ß": "prop_ß",
            },
            "read_only_properties": [
              "Created time",
              "Last edited
      time",
            ],
            "schema_hash": "sha256:9428298cb695f7f699f95895720239b6fc42e3a18c573933be9736bfba1419d2",
            "title_property": "",
          },
          "page_id": "00000000-0000-4000-8000-000000000101",
          "read_only_properties": {
            "": {
              "property_type": "rich_text",
              "value": null,
            },
            "Formula": {
              "property_type": "formula",
              "value": {
                "_tag": "string",
                "value": "line
      break",
              },
            },
            "Number ß": {
              "property_type": "number",
              "value": 0,
            },
          },
          "storage": {
            "_tag": "object_store",
            "comment_ids": [
              "comment
      one",
            ],
            "file_ids": [
              "",
              "file-ß",
            ],
            "object": {
              "_tag": "object_ref",
              "byte_length": 45,
              "hash": "sha256:4aefeac69ca66bbd60bfa738ef96b8cdba181bd65e0b2af14632f832d7e58dbc",
              "media_type": "application/json",
              "path": ".notion-md/objects/sha256/4a/efeac69ca66bbd60bfa738ef96b8cdba181bd65e0b2af14632f832d7e58dbc.json",
              "role": "storage_payload",
            },
            "unsupported_block_ids": [
              "00000000-0000-4000-8000-000000000103",
            ],
          },
          "version": 1,
        },
        "encoded": "{
        "version": 1,
        "page_id": "00000000-0000-4000-8000-000000000101",
        "body": {
          "format": "notion-enhanced-markdown",
          "hash": "sha256:631c4d09660eb980fabc42849c3ff762f13df107656f99ab24b560065dd3f9e9",
          "base": {
            "_tag": "object_ref",
            "role": "base_snapshot",
            "hash": "sha256:223f7565d00d6d334aee03cb9228f6b050038cb08a992d8327718a273e9eee3f",
            "path": ".notion-md/objects/sha256/22/3f7565d00d6d334aee03cb9228f6b050038cb08a992d8327718a273e9eee3f.json",
            "media_type": "application/json",
            "byte_length": 22
          },
          "last_pulled_at": "2026-07-28T10:15:00.000Z",
          "remote_last_edited_time": "9999-12-31T23:59:59.999Z",
          "truncated": false,
          "unknown_block_ids": [
            "00000000-0000-4000-8000-000000000102"
          ]
        },
        "storage": {
          "_tag": "object_store",
          "object": {
            "_tag": "object_ref",
            "role": "storage_payload",
            "hash": "sha256:4aefeac69ca66bbd60bfa738ef96b8cdba181bd65e0b2af14632f832d7e58dbc",
            "path": ".notion-md/objects/sha256/4a/efeac69ca66bbd60bfa738ef96b8cdba181bd65e0b2af14632f832d7e58dbc.json",
            "media_type": "application/json",
            "byte_length": 45
          },
          "unsupported_block_ids": [
            "00000000-0000-4000-8000-000000000103"
          ],
          "file_ids": [
            "",
            "file-ß"
          ],
          "comment_ids": [
            "comment\\r\\none"
          ]
        },
        "read_only_properties": {
          "": {
            "property_type": "rich_text",
            "value": null
          },
          "Number ß": {
            "property_type": "number",
            "value": 0
          },
          "Formula": {
            "property_type": "formula",
            "value": {
              "_tag": "string",
              "value": "line\\r\\nbreak"
            }
          }
        },
        "data_source": {
          "database_id": "00000000-0000-4000-8000-000000000104",
          "data_source_id": "00000000-0000-4000-8000-000000000105",
          "schema_hash": "sha256:9428298cb695f7f699f95895720239b6fc42e3a18c573933be9736bfba1419d2",
          "title_property": "",
          "property_ids": {
            "Name": "title",
            "Unicode ß": "prop_ß"
          },
          "read_only_properties": [
            "Created time",
            "Last edited\\r\\ntime"
          ]
        }
      }
      ",
        "reencoded": "{
        "version": 1,
        "page_id": "00000000-0000-4000-8000-000000000101",
        "body": {
          "format": "notion-enhanced-markdown",
          "hash": "sha256:631c4d09660eb980fabc42849c3ff762f13df107656f99ab24b560065dd3f9e9",
          "base": {
            "_tag": "object_ref",
            "role": "base_snapshot",
            "hash": "sha256:223f7565d00d6d334aee03cb9228f6b050038cb08a992d8327718a273e9eee3f",
            "path": ".notion-md/objects/sha256/22/3f7565d00d6d334aee03cb9228f6b050038cb08a992d8327718a273e9eee3f.json",
            "media_type": "application/json",
            "byte_length": 22
          },
          "last_pulled_at": "2026-07-28T10:15:00.000Z",
          "remote_last_edited_time": "9999-12-31T23:59:59.999Z",
          "truncated": false,
          "unknown_block_ids": [
            "00000000-0000-4000-8000-000000000102"
          ]
        },
        "storage": {
          "_tag": "object_store",
          "object": {
            "_tag": "object_ref",
            "role": "storage_payload",
            "hash": "sha256:4aefeac69ca66bbd60bfa738ef96b8cdba181bd65e0b2af14632f832d7e58dbc",
            "path": ".notion-md/objects/sha256/4a/efeac69ca66bbd60bfa738ef96b8cdba181bd65e0b2af14632f832d7e58dbc.json",
            "media_type": "application/json",
            "byte_length": 45
          },
          "unsupported_block_ids": [
            "00000000-0000-4000-8000-000000000103"
          ],
          "file_ids": [
            "",
            "file-ß"
          ],
          "comment_ids": [
            "comment\\r\\none"
          ]
        },
        "read_only_properties": {
          "": {
            "property_type": "rich_text",
            "value": null
          },
          "Number ß": {
            "property_type": "number",
            "value": 0
          },
          "Formula": {
            "property_type": "formula",
            "value": {
              "_tag": "string",
              "value": "line\\r\\nbreak"
            }
          }
        },
        "data_source": {
          "database_id": "00000000-0000-4000-8000-000000000104",
          "data_source_id": "00000000-0000-4000-8000-000000000105",
          "schema_hash": "sha256:9428298cb695f7f699f95895720239b6fc42e3a18c573933be9736bfba1419d2",
          "title_property": "",
          "property_ids": {
            "Name": "title",
            "Unicode ß": "prop_ß"
          },
          "read_only_properties": [
            "Created time",
            "Last edited\\r\\ntime"
          ]
        }
      }
      ",
      }
    `)

    expect({
      nullDocument: decodeFailure(NmdSyncStateV1Schema, 'null'),
      missingStorage: decodeFailure(
        NmdSyncStateV1Schema,
        '{"version":1,"page_id":"00000000-0000-4000-8000-000000000101","body":{},"read_only_properties":{},"data_source":null}',
      ),
      nullBase: decodeFailure(
        NmdSyncStateV1Schema,
        '{"version":1,"page_id":"00000000-0000-4000-8000-000000000101","body":{"format":"notion-enhanced-markdown","hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base":null,"last_pulled_at":"2026-07-28T10:15:00.000Z","remote_last_edited_time":"2026-07-28T10:15:00.000Z","truncated":false,"unknown_block_ids":[]},"storage":{"_tag":"self_contained","unsupported_blocks":[],"files":[],"comments":[]},"read_only_properties":{},"data_source":null}',
      ),
      excessTopLevel: decodeFailure(
        NmdSyncStateV1Schema,
        '{"version":1,"page_id":"00000000-0000-4000-8000-000000000101","body":{"format":"notion-enhanced-markdown","hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","base":{"_tag":"object_ref","role":"base_snapshot","hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","path":".notion-md/objects/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json","media_type":"application/json","byte_length":1},"last_pulled_at":"2026-07-28T10:15:00.000Z","remote_last_edited_time":"2026-07-28T10:15:00.000Z","truncated":false,"unknown_block_ids":[]},"storage":{"_tag":"self_contained","unsupported_blocks":[],"files":[],"comments":[]},"read_only_properties":{},"data_source":null,"extra":true}',
      ),
    }).toMatchInlineSnapshot(`
      {
        "excessTopLevel": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.SyncStateV1)
      └─ Type side transformation failure
         └─ NotionMd.SyncStateV1
            ├─ ["extra"]
            │  └─ is unexpected, expected: "version" | "page_id" | "body" | "storage" | "read_only_properties" | "data_source"
            └─ ["body"]
               └─ NotionMd.BodyState
                  ├─ ["hash"]
                  │  └─ NotionMd.Sha256Digest
                  │     └─ Predicate refinement failure
                  │        └─ Expected a string matching the pattern ^sha256:[a-f0-9]{64}$, actual "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  └─ ["base"]
                     └─ NotionMd.ObjectRef
                        └─ ["hash"]
                           └─ NotionMd.Sha256Digest
                              └─ Predicate refinement failure
                                 └─ Expected a string matching the pattern ^sha256:[a-f0-9]{64}$, actual "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",
        },
        "missingStorage": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.SyncStateV1)
      └─ Type side transformation failure
         └─ NotionMd.SyncStateV1
            ├─ ["body"]
            │  └─ NotionMd.BodyState
            │     ├─ ["format"]
            │     │  └─ is missing
            │     ├─ ["hash"]
            │     │  └─ is missing
            │     ├─ ["base"]
            │     │  └─ is missing
            │     ├─ ["last_pulled_at"]
            │     │  └─ is missing
            │     ├─ ["remote_last_edited_time"]
            │     │  └─ is missing
            │     ├─ ["truncated"]
            │     │  └─ is missing
            │     └─ ["unknown_block_ids"]
            │        └─ is missing
            └─ ["storage"]
               └─ is missing",
        },
        "nullBase": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.SyncStateV1)
      └─ Type side transformation failure
         └─ NotionMd.SyncStateV1
            └─ ["body"]
               └─ NotionMd.BodyState
                  ├─ ["hash"]
                  │  └─ NotionMd.Sha256Digest
                  │     └─ Predicate refinement failure
                  │        └─ Expected a string matching the pattern ^sha256:[a-f0-9]{64}$, actual "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
                  └─ ["base"]
                     └─ Expected NotionMd.ObjectRef, actual null",
        },
        "nullDocument": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.SyncStateV1)
      └─ Type side transformation failure
         └─ Expected NotionMd.SyncStateV1, actual null",
        },
      }
    `)
  })

  // TODO(live-migration:effect-3-4): Effect 4 reassigns Schema.Date and renders SchemaError(...); preserve ISO object bytes and adjudicate internal failure text before re-baselining.
  it('captures state-store object JSON bytes and failure partition', () => {
    const baseSnapshot: NmdBaseSnapshotV2 = {
      version: 2,
      page_id: '00000000-0000-4000-8000-000000000201',
      body_hash: sha256Digest('Heading\n\nBody ß\n'),
      body: 'Heading\r\n\r\nBody ß',
    }
    const storageObject: NmdStorageObjectV2 = {
      version: 2,
      page_id: '00000000-0000-4000-8000-000000000201',
      reason: 'volatile_url',
      storage: {
        _tag: 'self_contained',
        unsupported_blocks: [
          {
            _tag: 'unsupported_block',
            block_id: '00000000-0000-4000-8000-000000000202',
            block_type: 'synced_block',
            placeholder: '<unsupported-block id="00000000-0000-4000-8000-000000000202" />',
            snapshot: {
              object: 'block',
              id: '00000000-0000-4000-8000-000000000202',
              type: 'synced_block',
              has_children: false,
              in_trash: false,
              parent: { type: 'page_id', page_id: '00000000-0000-4000-8000-000000000201' },
              created_time: '2026-07-28T10:15:00.000Z',
              last_edited_time: '2026-07-28T10:16:00.000Z',
              payload: { text: 'Grüße\r\n東京', empty: '', nullable: null },
            },
          },
        ],
        files: [
          {
            _tag: 'file_unit',
            id: 'file-1',
            role: 'block_file',
            filename: 'report ß.pdf',
            content_type: 'application/pdf',
            local_path: 'files/report ß.pdf',
            content_hash: sha256Digest('file bytes'),
          },
        ],
        comments: [
          {
            _tag: 'comment_unit',
            id: 'comment-1',
            roughdraft_id: '',
            anchor_text: 'line one\r\nline two',
          },
        ],
      },
    }

    expect({
      baseSnapshot: roundTripFileJson(NmdBaseSnapshotV2, baseSnapshot),
      storageObject: roundTripFileJson(NmdStorageObjectV2, storageObject),
    }).toMatchInlineSnapshot(`
      {
        "baseSnapshot": {
          "byteIdentical": true,
          "decoded": {
            "body": "Heading

      Body ß",
            "body_hash": "sha256:0d18204edf4d58d18581b1aded039bab28eed61d5d6fd601d43e04e5e6207efb",
            "page_id": "00000000-0000-4000-8000-000000000201",
            "version": 2,
          },
          "encoded": "{
        "version": 2,
        "page_id": "00000000-0000-4000-8000-000000000201",
        "body_hash": "sha256:0d18204edf4d58d18581b1aded039bab28eed61d5d6fd601d43e04e5e6207efb",
        "body": "Heading\\r\\n\\r\\nBody ß"
      }
      ",
          "reencoded": "{
        "version": 2,
        "page_id": "00000000-0000-4000-8000-000000000201",
        "body_hash": "sha256:0d18204edf4d58d18581b1aded039bab28eed61d5d6fd601d43e04e5e6207efb",
        "body": "Heading\\r\\n\\r\\nBody ß"
      }
      ",
        },
        "storageObject": {
          "byteIdentical": true,
          "decoded": {
            "page_id": "00000000-0000-4000-8000-000000000201",
            "reason": "volatile_url",
            "storage": {
              "_tag": "self_contained",
              "comments": [
                {
                  "_tag": "comment_unit",
                  "anchor_text": "line one
      line two",
                  "id": "comment-1",
                  "roughdraft_id": "",
                },
              ],
              "files": [
                {
                  "_tag": "file_unit",
                  "content_hash": "sha256:4f85ab790f08374b7408ce7463ee3fe0d20fc8f7ab2a5df649f4dc53386eabc4",
                  "content_type": "application/pdf",
                  "filename": "report ß.pdf",
                  "id": "file-1",
                  "local_path": "files/report ß.pdf",
                  "role": "block_file",
                },
              ],
              "unsupported_blocks": [
                {
                  "_tag": "unsupported_block",
                  "block_id": "00000000-0000-4000-8000-000000000202",
                  "block_type": "synced_block",
                  "placeholder": "<unsupported-block id="00000000-0000-4000-8000-000000000202" />",
                  "snapshot": {
                    "created_time": "2026-07-28T10:15:00.000Z",
                    "has_children": false,
                    "id": "00000000-0000-4000-8000-000000000202",
                    "in_trash": false,
                    "last_edited_time": "2026-07-28T10:16:00.000Z",
                    "object": "block",
                    "parent": {
                      "page_id": "00000000-0000-4000-8000-000000000201",
                      "type": "page_id",
                    },
                    "payload": {
                      "empty": "",
                      "nullable": null,
                      "text": "Grüße
      東京",
                    },
                    "type": "synced_block",
                  },
                },
              ],
            },
            "version": 2,
          },
          "encoded": "{
        "version": 2,
        "page_id": "00000000-0000-4000-8000-000000000201",
        "reason": "volatile_url",
        "storage": {
          "_tag": "self_contained",
          "unsupported_blocks": [
            {
              "_tag": "unsupported_block",
              "block_id": "00000000-0000-4000-8000-000000000202",
              "block_type": "synced_block",
              "placeholder": "<unsupported-block id=\\"00000000-0000-4000-8000-000000000202\\" />",
              "snapshot": {
                "object": "block",
                "id": "00000000-0000-4000-8000-000000000202",
                "type": "synced_block",
                "has_children": false,
                "in_trash": false,
                "parent": {
                  "type": "page_id",
                  "page_id": "00000000-0000-4000-8000-000000000201"
                },
                "created_time": "2026-07-28T10:15:00.000Z",
                "last_edited_time": "2026-07-28T10:16:00.000Z",
                "payload": {
                  "text": "Grüße\\r\\n東京",
                  "empty": "",
                  "nullable": null
                }
              }
            }
          ],
          "files": [
            {
              "_tag": "file_unit",
              "id": "file-1",
              "role": "block_file",
              "filename": "report ß.pdf",
              "content_type": "application/pdf",
              "local_path": "files/report ß.pdf",
              "content_hash": "sha256:4f85ab790f08374b7408ce7463ee3fe0d20fc8f7ab2a5df649f4dc53386eabc4"
            }
          ],
          "comments": [
            {
              "_tag": "comment_unit",
              "id": "comment-1",
              "roughdraft_id": "",
              "anchor_text": "line one\\r\\nline two"
            }
          ]
        }
      }
      ",
          "reencoded": "{
        "version": 2,
        "page_id": "00000000-0000-4000-8000-000000000201",
        "reason": "volatile_url",
        "storage": {
          "_tag": "self_contained",
          "unsupported_blocks": [
            {
              "_tag": "unsupported_block",
              "block_id": "00000000-0000-4000-8000-000000000202",
              "block_type": "synced_block",
              "placeholder": "<unsupported-block id=\\"00000000-0000-4000-8000-000000000202\\" />",
              "snapshot": {
                "object": "block",
                "id": "00000000-0000-4000-8000-000000000202",
                "type": "synced_block",
                "has_children": false,
                "in_trash": false,
                "parent": {
                  "type": "page_id",
                  "page_id": "00000000-0000-4000-8000-000000000201"
                },
                "created_time": "2026-07-28T10:15:00.000Z",
                "last_edited_time": "2026-07-28T10:16:00.000Z",
                "payload": {
                  "text": "Grüße\\r\\n東京",
                  "empty": "",
                  "nullable": null
                }
              }
            }
          ],
          "files": [
            {
              "_tag": "file_unit",
              "id": "file-1",
              "role": "block_file",
              "filename": "report ß.pdf",
              "content_type": "application/pdf",
              "local_path": "files/report ß.pdf",
              "content_hash": "sha256:4f85ab790f08374b7408ce7463ee3fe0d20fc8f7ab2a5df649f4dc53386eabc4"
            }
          ],
          "comments": [
            {
              "_tag": "comment_unit",
              "id": "comment-1",
              "roughdraft_id": "",
              "anchor_text": "line one\\r\\nline two"
            }
          ]
        }
      }
      ",
        },
      }
    `)

    expect({
      baseNullDocument: decodeFailure(NmdBaseSnapshotV2, 'null'),
      baseBadVersion: decodeFailure(
        NmdBaseSnapshotV2,
        '{"version":1,"page_id":"00000000-0000-4000-8000-000000000201","body_hash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","body":""}',
      ),
      storageUnknownTag: decodeFailure(
        NmdStorageObjectV2,
        '{"version":2,"page_id":"00000000-0000-4000-8000-000000000201","reason":"too_large","storage":{"_tag":"unknown"}}',
      ),
      storageNullPayload: decodeFailure(
        NmdStorageObjectV2,
        '{"version":2,"page_id":"00000000-0000-4000-8000-000000000201","reason":"too_large","storage":null}',
      ),
    }).toMatchInlineSnapshot(`
      {
        "baseBadVersion": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.BaseSnapshotV2)
      └─ Type side transformation failure
         └─ NotionMd.BaseSnapshotV2
            ├─ ["version"]
            │  └─ Expected 2, actual 1
            └─ ["body_hash"]
               └─ NotionMd.Sha256Digest
                  └─ Predicate refinement failure
                     └─ Expected a string matching the pattern ^sha256:[a-f0-9]{64}$, actual "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"",
        },
        "baseNullDocument": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.BaseSnapshotV2)
      └─ Type side transformation failure
         └─ Expected NotionMd.BaseSnapshotV2, actual null",
        },
        "storageNullPayload": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.StorageObjectV2)
      └─ Type side transformation failure
         └─ NotionMd.StorageObjectV2
            └─ ["storage"]
               └─ Expected NotionMd.Storage, actual null",
        },
        "storageUnknownTag": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.StorageObjectV2)
      └─ Type side transformation failure
         └─ NotionMd.StorageObjectV2
            └─ ["storage"]
               └─ NotionMd.Storage
                  └─ { readonly _tag: "self_contained" | "object_store" }
                     └─ ["_tag"]
                        └─ Expected "self_contained" | "object_store", actual "unknown"",
        },
      }
    `)
  })

  // TODO(live-migration:effect-3-4): Effect 4 renders SchemaError(...) for these failures; preserve the tree-index structural partition and adjudicate internal-only text before re-baselining.
  it('captures tree-index JSON bytes and failure partition', () => {
    expect(
      roundTripFileJson(TreeIndex, {
        version: 1,
        root_page_id: '00000000-0000-4000-8000-000000000301',
        root_file: 'README.nmd',
        pages: {
          '': '00000000-0000-4000-8000-000000000302',
          'alpha.nmd': '00000000-0000-4000-8000-000000000303',
          'guide/setup ß.nmd': '00000000-0000-4000-8000-000000000304',
          'windows\r\nline.nmd': '00000000-0000-4000-8000-000000000305',
        },
      }),
    ).toMatchInlineSnapshot(`
      {
        "byteIdentical": true,
        "decoded": {
          "pages": {
            "": "00000000-0000-4000-8000-000000000302",
            "alpha.nmd": "00000000-0000-4000-8000-000000000303",
            "guide/setup ß.nmd": "00000000-0000-4000-8000-000000000304",
            "windows
      line.nmd": "00000000-0000-4000-8000-000000000305",
          },
          "root_file": "README.nmd",
          "root_page_id": "00000000-0000-4000-8000-000000000301",
          "version": 1,
        },
        "encoded": "{
        "version": 1,
        "root_page_id": "00000000-0000-4000-8000-000000000301",
        "root_file": "README.nmd",
        "pages": {
          "": "00000000-0000-4000-8000-000000000302",
          "alpha.nmd": "00000000-0000-4000-8000-000000000303",
          "guide/setup ß.nmd": "00000000-0000-4000-8000-000000000304",
          "windows\\r\\nline.nmd": "00000000-0000-4000-8000-000000000305"
        }
      }
      ",
        "reencoded": "{
        "version": 1,
        "root_page_id": "00000000-0000-4000-8000-000000000301",
        "root_file": "README.nmd",
        "pages": {
          "": "00000000-0000-4000-8000-000000000302",
          "alpha.nmd": "00000000-0000-4000-8000-000000000303",
          "guide/setup ß.nmd": "00000000-0000-4000-8000-000000000304",
          "windows\\r\\nline.nmd": "00000000-0000-4000-8000-000000000305"
        }
      }
      ",
      }
    `)

    expect({
      nullDocument: decodeFailure(TreeIndex, 'null'),
      missingRootFile: decodeFailure(
        TreeIndex,
        '{"version":1,"root_page_id":"00000000-0000-4000-8000-000000000301","pages":{}}',
      ),
      nullPageId: decodeFailure(
        TreeIndex,
        '{"version":1,"root_page_id":"00000000-0000-4000-8000-000000000301","root_file":"README.nmd","pages":{"alpha.nmd":null}}',
      ),
      excessTopLevel: decodeFailure(
        TreeIndex,
        '{"version":1,"root_page_id":"00000000-0000-4000-8000-000000000301","root_file":"README.nmd","pages":{},"extra":true}',
      ),
    }).toMatchInlineSnapshot(`
      {
        "excessTopLevel": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.TreeIndex)
      └─ Type side transformation failure
         └─ NotionMd.TreeIndex
            └─ ["extra"]
               └─ is unexpected, expected: "version" | "root_page_id" | "root_file" | "pages"",
        },
        "missingRootFile": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.TreeIndex)
      └─ Type side transformation failure
         └─ NotionMd.TreeIndex
            └─ ["root_file"]
               └─ is missing",
        },
        "nullDocument": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.TreeIndex)
      └─ Type side transformation failure
         └─ Expected NotionMd.TreeIndex, actual null",
        },
        "nullPageId": {
          "_tag": "failed",
          "error": "(parseJson <-> NotionMd.TreeIndex)
      └─ Type side transformation failure
         └─ NotionMd.TreeIndex
            └─ ["pages"]
               └─ { readonly [x: string]: string }
                  └─ ["alpha.nmd"]
                     └─ Expected string, actual null",
        },
      }
    `)
  })
})

describe('notion-md state store object lifecycle', () => {
  it('dry-runs object garbage collection without deleting unreachable objects', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000001'
      const base = await runStore(writeBaseSnapshot({ path, pageId, body: '# Base' }))
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      const result = await runStore(
        garbageCollectObjects({
          path,
          syncStates: [syncStateFor({ pageId, body: '# Base', base })],
          dryRun: true,
        }),
      )

      expect(result.dryRun).toBe(true)
      expect(result.removed).toEqual([orphanPath])
      await expect(readFile(orphanPath, 'utf8')).resolves.toBe(orphanContent)
    })
  })

  it('removes unreachable objects while keeping referenced base objects', async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000001'
      const base = await runStore(writeBaseSnapshot({ path, pageId, body: '# Base' }))
      const basePath = objectPath({ path, hash: base.hash })
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      const result = await runStore(
        garbageCollectObjects({
          path,
          syncStates: [syncStateFor({ pageId, body: '# Base', base })],
        }),
      )

      expect(result.removed).toEqual([orphanPath])
      await expect(readFile(basePath, 'utf8')).resolves.toContain('# Base')
      await expect(readFile(orphanPath, 'utf8')).rejects.toThrow()
    })
  })
})

const runFs = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

describe('notion-md gc command discovery', () => {
  it('readAllSyncStates returns empty array when no sync directory exists', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const syncStates = await runFs(readAllSyncStates(nmdPath))
      expect(syncStates).toEqual([])
    })
  })

  it('readAllSyncStates discovers sync states written by writeSyncState', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000002'
      const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Hello' }))
      const syncState = syncStateFor({ pageId, body: '# Hello', base })
      await runStore(writeSyncState({ path: nmdPath, syncState }))

      const found = await runFs(readAllSyncStates(nmdPath))
      expect(found).toHaveLength(1)
      expect(found[0]?.page_id).toBe(pageId)
    })
  })

  it('gc plan-only (no --prune): identifies unreachable objects without deleting them', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const pageId = '00000000-0000-4000-8000-000000000003'
      const base = await runStore(writeBaseSnapshot({ path: nmdPath, pageId, body: '# Plan' }))
      const syncState = syncStateFor({ pageId, body: '# Plan', base })
      await runStore(writeSyncState({ path: nmdPath, syncState }))

      // Add an orphan object
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      // Dry-run (plan only): discover sync states from disk, do not delete
      const syncStates = await runFs(readAllSyncStates(nmdPath))
      const result = await runStore(
        garbageCollectObjects({ path: nmdPath, syncStates, dryRun: true }),
      )

      expect(result.dryRun).toBe(true)
      expect(result.removed).toContain(orphanPath)
      // Object must still exist on disk
      await expect(readFile(orphanPath, 'utf8')).resolves.toBe(orphanContent)
    })
  })

  it('gc --prune: removes unreachable objects, keeps all objects reachable from sync states', async () => {
    await withTempDir(async (dir) => {
      const nmdPath = join(dir, 'doc.nmd')
      const pageIdA = '00000000-0000-4000-8000-000000000004'
      const pageIdB = '00000000-0000-4000-8000-000000000005'

      // Write two base snapshots (two pages in the same directory / state root)
      const baseA = await runStore(
        writeBaseSnapshot({ path: nmdPath, pageId: pageIdA, body: '# A' }),
      )
      const baseB = await runStore(
        writeBaseSnapshot({ path: nmdPath, pageId: pageIdB, body: '# B' }),
      )
      const syncStateA = syncStateFor({ pageId: pageIdA, body: '# A', base: baseA })
      const syncStateB = syncStateFor({ pageId: pageIdB, body: '# B', base: baseB })
      await runStore(writeSyncState({ path: nmdPath, syncState: syncStateA }))
      await runStore(writeSyncState({ path: nmdPath, syncState: syncStateB }))

      // Add an orphan object
      const orphanContent = '{"orphan":true}\n'
      const orphanHash = sha256Digest(orphanContent)
      const orphanPath = objectPath({ path: nmdPath, hash: orphanHash })
      await mkdir(dirname(orphanPath), { recursive: true })
      await writeFile(orphanPath, orphanContent)

      // Discover sync states from disk (as the gc command does), then prune
      const syncStates = await runFs(readAllSyncStates(nmdPath))
      expect(syncStates).toHaveLength(2)
      const result = await runStore(
        garbageCollectObjects({ path: nmdPath, syncStates, dryRun: false }),
      )

      // Orphan removed, both base snapshots kept
      expect(result.removed).toContain(orphanPath)
      expect(result.reachable).toContain(objectPath({ path: nmdPath, hash: baseA.hash }))
      expect(result.reachable).toContain(objectPath({ path: nmdPath, hash: baseB.hash }))
      await expect(readFile(orphanPath, 'utf8')).rejects.toThrow()
      await expect(
        readFile(objectPath({ path: nmdPath, hash: baseA.hash }), 'utf8'),
      ).resolves.toContain('# A')
      await expect(
        readFile(objectPath({ path: nmdPath, hash: baseB.hash }), 'utf8'),
      ).resolves.toContain('# B')
    })
  })
})
