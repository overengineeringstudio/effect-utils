import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { encodeJson } from '../test-utils/mod.ts'
import {
  WorktreeHolderEvidenceSchema,
  WorktreeHolderEvidenceRequestSchema,
  decodeWorktreeHolderEvidence,
  type WorktreeHolderEvidence,
} from './store-worktree-holder-codec.ts'

// The sole producer-owned asset is checked against actual Rust codec stdout by its
// Nix builder. These bounded tests consume bytes, not a live socket or a fake helper.
const fixturePath = fileURLToPath(
  new URL('./fixtures/worktree-holder-evidence-v1.jsonl', import.meta.url),
)
const fixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const jsonl = yield* fs.readFileString(fixturePath)
  const lines = jsonl.trimEnd().split('\n')
  expect(lines).toHaveLength(10)
  const decoded = yield* Effect.forEach(lines, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(WorktreeHolderEvidenceSchema), {
      onExcessProperty: 'error',
    })(line),
  )
  return { lines, decoded }
})
const binding = (evidence: WorktreeHolderEvidence) => ({
  client: {
    path: `${evidence.producerId}/bin/worktree-holder-evidence`,
    producerId: evidence.producerId,
    policyId: evidence.policyId,
  },
  paths: evidence.roots.map((root) => root.path),
  nonce: evidence.nonce,
})

describe('native holder evidence worktree request', () => {
  it.effect('shares real producer roots and rejects malformed, repeated or excessive scope', () =>
    Effect.gen(function* () {
      const { decoded } = yield* fixtures
      const actual = decoded[0]!
      const paths = actual.roots.map((root) => root.path)
      const request = { version: 1, nonce: actual.nonce, kind: 'worktree', paths }
      expect(yield* Schema.decodeEffect(WorktreeHolderEvidenceRequestSchema)(request)).toEqual(
        request,
      )
      const invalid: ReadonlyArray<unknown> = [
        { ...request, version: 2 },
        { ...request, nonce: 'f'.repeat(31) },
        { ...request, kind: 'store' },
        { ...request, store: null },
        { ...request, paths: [] },
        { ...request, paths: [paths[0], paths[0]] },
        { ...request, paths: ['/'] },
        { ...request, paths: ['relative'] },
        { ...request, paths: ['/root/../other'] },
        { ...request, paths: ['/root/./child'] },
        { ...request, paths: ['/root//child'] },
        { ...request, paths: ['/root/'] },
        { ...request, paths: ['/root/\nchild'] },
        { ...request, paths: ['/root/\u0000child'] },
        { ...request, paths: ['/root/\ud800'] },
        { ...request, paths: [`/${'é'.repeat(2048)}`] },
        { ...request, paths: Array.from({ length: 4097 }, (_, index) => `/root/${index}`) },
      ]
      for (const value of invalid) {
        const result = yield* Schema.decodeEffect(WorktreeHolderEvidenceRequestSchema, {
          onExcessProperty: 'error',
        })(value).pipe(Effect.exit)
        expect(result._tag).toBe('Failure')
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})

describe('native holder evidence Rust codec authority', () => {
  it.effect('accepts all actual emitted cases without changing scoped roots or receipts', () =>
    Effect.gen(function* () {
      const { lines, decoded } = yield* fixtures
      for (const [index, evidence] of decoded.entries()) {
        expect(
          yield* decodeWorktreeHolderEvidence({ ...binding(evidence), json: lines[index]! }),
        ).toEqual(evidence)
      }
      expect(decoded[0]!.roots[0]!.status).toBe('no-current-reference')
      for (const index of [1, 2, 3]) expect(decoded[index]!.roots[0]!.status).toBe('in-use')
      expect(decoded[4]!.roots[0]!.complete).toBe(false)
      expect(decoded[5]!.roots.map((root) => root.status)).toEqual([
        'no-current-reference',
        'unknown',
      ])
      expect(decoded[6]!.roots[0]!.references[0]).toMatchObject({
        tgid: 123,
        leaderStart: '456',
        tid: 124,
        taskStart: '457',
      })
      expect(decoded[7]!.roots[0]!.references[0]!.effect).toBe('retained-bytes')
      expect(decoded[8]!.roots[0]!.identity).toBeNull()
      expect(decoded[8]!.roots[0]!.status).toBe('unknown')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect(
    'rejects structural, integer, scope, status and capture mutations of actual bytes',
    () =>
      Effect.gen(function* () {
        const { decoded } = yield* fixtures
        const clear = decoded[0]!
        const root = clear.roots[0]!
        const held = decoded[1]!
        const reference = held.roots[0]!.references[0]!
        const mutations: ReadonlyArray<unknown> = [
          { ...clear, extra: true },
          { ...clear, scope: { ...clear.scope, extra: true } },
          { ...clear, capture: { ...clear.capture, startedBootNs: '01' } },
          { ...clear, capture: { ...clear.capture, startedBootNs: '18446744073709551616' } },
          { ...clear, capture: { ...clear.capture, expiresBootNs: '32000000000' } },
          { ...clear, capture: { ...clear.capture, finishedBootNs: '27000000000' } },
          { ...clear, scope: { ...clear.scope, complete: false } },
          { ...clear, scope: { ...clear.scope, allUids: false } },
          { ...clear, scope: { ...clear.scope, taskCount: 4294967296 } },
          { ...clear, scope: { ...clear.scope, digest: 'not-a-digest' } },
          ...(['user', 'pid', 'mnt', 'net'] as const).map((field) => ({
            ...clear,
            scope: { ...clear.scope, namespaces: { ...clear.scope.namespaces, [field]: '0' } },
          })),
          { ...clear, bootId: 'not-a-uuid' },
          { ...clear, roots: [{ ...root, complete: false }] },
          { ...clear, roots: [{ ...root, referencesComplete: false }] },
          { ...clear, roots: [{ ...root, identity: null }] },
          { ...clear, roots: [{ ...root, unknownReasons: ['permission'] }] },
          { ...clear, roots: [{ ...root, identity: { ...root.identity, ino: 1 } }] },
          ...(['ino', 'mountId'] as const).map((field) => ({
            ...clear,
            roots: [{ ...root, identity: { ...root.identity, [field]: '0' } }],
          })),
          { ...clear, roots: [{ ...root, path: '/' }] },
          { ...clear, roots: [{ ...root, path: '/work/../tree' }] },
          { ...clear, roots: [{ ...root, status: 'in-use' }] },
          {
            ...held,
            roots: [{ ...held.roots[0]!, references: [{ ...reference, uid: [0, 0, 0] }] }],
          },
          {
            ...held,
            roots: [{ ...held.roots[0]!, references: [{ ...reference, tid: 4294967296 }] }],
          },
          {
            ...held,
            roots: [
              { ...held.roots[0]!, references: [{ ...reference, relativePath: '../outside' }] },
            ],
          },
          {
            ...held,
            roots: [
              { ...held.roots[0]!, references: Array.from({ length: 4097 }, () => reference) },
            ],
          },
          ...(['leaderStart', 'taskStart'] as const).map((field) => ({
            ...held,
            roots: [{ ...held.roots[0]!, references: [{ ...reference, [field]: '0' }] }],
          })),
          ...(['ino', 'mountId'] as const).map((field) => ({
            ...held,
            roots: [
              {
                ...held.roots[0]!,
                references: [{ ...reference, identity: { ...reference.identity, [field]: '0' } }],
              },
            ],
          })),
        ]
        for (const value of mutations) {
          const json = encodeJson(value)
          const structural = yield* Schema.decodeEffect(
            Schema.fromJsonString(WorktreeHolderEvidenceSchema),
            {
              onExcessProperty: 'error',
            },
          )(json).pipe(Effect.exit)
          expect(structural._tag).toBe('Failure')
          expect(yield* decodeWorktreeHolderEvidence({ ...binding(clear), json })).toBeUndefined()
        }
        expect(
          yield* decodeWorktreeHolderEvidence({ ...binding(clear), json: '{' }),
        ).toBeUndefined()
        expect(
          yield* decodeWorktreeHolderEvidence({
            ...binding(clear),
            json: ' '.repeat(16 * 1024 * 1024 + 1),
          }),
        ).toBeUndefined()
      }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect(
    'rejects retained-byte or non-null-fd mutations of an actual mounted-root reference',
    () =>
      Effect.gen(function* () {
        const { decoded } = yield* fixtures
        const mounted = decoded.find((evidence) =>
          evidence.roots.some((root) =>
            root.references.some((reference) => reference.reference === 'mount'),
          ),
        )!
        for (const invalid of [{ effect: 'retained-bytes' }, { fd: 0 }]) {
          const value = {
            ...mounted,
            roots: mounted.roots.map((root) => ({
              ...root,
              references: root.references.map((reference) =>
                reference.reference === 'mount' ? { ...reference, ...invalid } : reference,
              ),
            })),
          }
          expect(
            yield* decodeWorktreeHolderEvidence({ ...binding(mounted), json: encodeJson(value) }),
          ).toBeUndefined()
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('accepts only exactly bound nonleader thread fd aliases and rejects every drift', () =>
    Effect.gen(function* () {
      const { decoded } = yield* fixtures
      const evidence = decoded[1]!
      const root = evidence.roots[0]!
      const base = root.references[0]!
      const thread = {
        ...base,
        tid: base.tgid + 1,
        taskStart: `${base.leaderStart}7`,
        reference: 'fd' as const,
        fd: 3,
      }
      const alias = {
        proof: 'pidfd-kcmp-files-and-file-v1',
        tgid: thread.tgid,
        leaderStart: thread.leaderStart,
        tid: thread.tid,
        taskStart: thread.taskStart,
        fd: 3,
      }
      const valid = {
        ...evidence,
        roots: [{ ...root, references: [{ ...thread, leaderFdAlias: alias }] }],
      }
      expect(
        yield* decodeWorktreeHolderEvidence({ ...binding(evidence), json: encodeJson(valid) }),
      ).toMatchObject({
        roots: [{ references: [{ leaderFdAlias: alias }] }],
      })
      const invalid: ReadonlyArray<unknown> = [
        { ...thread, leaderFdAlias: { ...alias, fd: 4 } },
        { ...thread, leaderFdAlias: { ...alias, tid: thread.tid + 5 } },
        { ...thread, leaderFdAlias: { ...alias, tgid: thread.tgid + 5 } },
        { ...thread, leaderFdAlias: { ...alias, taskStart: `${thread.taskStart}9` } },
        { ...thread, leaderFdAlias: { ...alias, leaderStart: `${thread.leaderStart}9` } },
        { ...thread, leaderFdAlias: { ...alias, proof: 'fd-equality-v0' } },
        { ...thread, fd: null, leaderFdAlias: alias },
        // A fully bound alias on a true leader row: only the nonleader clause rejects it.
        {
          ...thread,
          tid: thread.tgid,
          taskStart: thread.leaderStart,
          leaderFdAlias: { ...alias, tid: thread.tgid, taskStart: thread.leaderStart },
        },
      ]
      for (const reference of invalid) {
        const value = {
          ...evidence,
          roots: [{ ...root, references: [reference] }],
        }
        expect(
          yield* decodeWorktreeHolderEvidence({
            ...binding(evidence),
            json: encodeJson(value),
          }),
        ).toBeUndefined()
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('decodes the actual producer-emitted thread alias fixture bytes', () =>
    Effect.gen(function* () {
      const { lines, decoded } = yield* fixtures
      const aliased = decoded[9]!
      const reference = aliased.roots[0]!.references[0]!
      expect(reference).toMatchObject({
        tgid: 61,
        leaderStart: '700',
        tid: 62,
        taskStart: '701',
        reference: 'fd',
        fd: 20,
        leaderFdAlias: {
          proof: 'pidfd-kcmp-files-and-file-v1',
          tgid: 61,
          leaderStart: '700',
          tid: 62,
          taskStart: '701',
          fd: 20,
        },
      })
      expect(yield* decodeWorktreeHolderEvidence({ ...binding(aliased), json: lines[9]! })).toEqual(
        aliased,
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('rejects binding, requested order, coverage and nonce changes', () =>
    Effect.gen(function* () {
      const { decoded, lines } = yield* fixtures
      const evidence = decoded[5]!
      const expected = binding(evidence)
      const json = lines[5]!
      for (const input of [
        { ...expected, nonce: 'f'.repeat(32), json },
        { ...expected, paths: [...expected.paths].reverse(), json },
        { ...expected, paths: [...expected.paths, '/unrequested'], json },
        { ...expected, paths: [expected.paths[0]!, expected.paths[0]!], json },
        { ...expected, client: { ...expected.client, policyId: 'f'.repeat(64) }, json },
        {
          ...expected,
          client: { ...expected.client, path: '/bin/worktree-holder-evidence' },
          json,
        },
        { ...expected, json: encodeJson({ ...evidence, kind: 'store' }) },
        { ...expected, json: encodeJson({ ...evidence, model: 'unmanaged' }) },
        {
          ...expected,
          json: encodeJson({ ...evidence, producerId: `${evidence.producerId}-other` }),
        },
        {
          ...expected,
          json: encodeJson({
            ...evidence,
            scope: { ...evidence.scope, requestedPathsDigest: 'f'.repeat(64) },
          }),
        },
      ])
        expect(yield* decodeWorktreeHolderEvidence(input)).toBeUndefined()
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
