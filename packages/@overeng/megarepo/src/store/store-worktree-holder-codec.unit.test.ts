import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { encodeJson } from '../test-utils/mod.ts'
import {
  WorktreeHolderEvidenceSchema,
  decodeWorktreeHolderEvidence,
  type WorktreeHolderEvidence,
} from './store-worktree-holder-codec.ts'

// The sole producer-owned asset is checked against actual Rust codec stdout by its
// Nix builder. These bounded tests consume bytes, not a live socket or a fake helper.
const fixturePath = fileURLToPath(new URL('./fixtures/worktree-holder-evidence-v1.jsonl', import.meta.url))
const fixtures = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const jsonl = yield* fs.readFileString(fixturePath)
  const lines = jsonl.trimEnd().split('\n')
  expect(lines).toHaveLength(9)
  const decoded = yield* Effect.forEach(lines, (line) =>
    Schema.decodeEffect(Schema.fromJsonString(WorktreeHolderEvidenceSchema), { onExcessProperty: 'error' })(line),
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

describe('native holder evidence Rust codec authority', () => {
  it.effect('accepts all actual emitted cases without changing scoped roots or receipts', () =>
    Effect.gen(function* () {
      const { lines, decoded } = yield* fixtures
      for (const [index, evidence] of decoded.entries()) {
        expect(yield* decodeWorktreeHolderEvidence({ ...binding(evidence), json: lines[index]! })).toEqual(evidence)
      }
      expect(decoded[0]!.roots[0]!.status).toBe('no-current-reference')
      for (const index of [1, 2, 3]) expect(decoded[index]!.roots[0]!.status).toBe('in-use')
      expect(decoded[4]!.roots[0]!.complete).toBe(false)
      expect(decoded[5]!.roots.map((root) => root.status)).toEqual(['no-current-reference', 'unknown'])
      expect(decoded[6]!.roots[0]!.references[0]).toMatchObject({
        tgid: 123, leaderStart: '456', tid: 124, taskStart: '457',
      })
      expect(decoded[7]!.roots[0]!.references[0]!.effect).toBe('retained-bytes')
      expect(decoded[8]!.roots[0]!.identity).toBeNull()
      expect(decoded[8]!.roots[0]!.status).toBe('unknown')
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('rejects structural, integer, scope, status and capture mutations of actual bytes', () =>
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
        { ...clear, bootId: 'not-a-uuid' },
        { ...clear, roots: [{ ...root, complete: false }] },
        { ...clear, roots: [{ ...root, referencesComplete: false }] },
        { ...clear, roots: [{ ...root, identity: null }] },
        { ...clear, roots: [{ ...root, unknownReasons: ['permission'] }] },
        { ...clear, roots: [{ ...root, identity: { ...root.identity, ino: 1 } }] },
        { ...clear, roots: [{ ...root, path: '/work/../tree' }] },
        { ...clear, roots: [{ ...root, status: 'in-use' }] },
        { ...held, roots: [{ ...held.roots[0]!, references: [{ ...reference, uid: [0, 0, 0] }] }] },
        { ...held, roots: [{ ...held.roots[0]!, references: [{ ...reference, tid: 4294967296 }] }] },
        { ...held, roots: [{ ...held.roots[0]!, references: [{ ...reference, relativePath: '../outside' }] }] },
        { ...held, roots: [{ ...held.roots[0]!, references: Array.from({ length: 4097 }, () => reference) }] },
      ]
      for (const value of mutations) {
        expect(yield* decodeWorktreeHolderEvidence({ ...binding(clear), json: encodeJson(value) })).toBeUndefined()
      }
      expect(yield* decodeWorktreeHolderEvidence({ ...binding(clear), json: '{' })).toBeUndefined()
      expect(yield* decodeWorktreeHolderEvidence({ ...binding(clear), json: ' '.repeat(16 * 1024 * 1024 + 1) })).toBeUndefined()
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('rejects retained-byte or non-null-fd mutations of an actual mounted-root reference', () =>
    Effect.gen(function* () {
      const { decoded } = yield* fixtures
      const mounted = decoded.find((evidence) => evidence.roots.some((root) =>
        root.references.some((reference) => reference.reference === 'mount')))!
      for (const invalid of [{ effect: 'retained-bytes' }, { fd: 0 }]) {
        const value = { ...mounted, roots: mounted.roots.map((root) => ({
          ...root,
          references: root.references.map((reference) =>
            reference.reference === 'mount' ? { ...reference, ...invalid } : reference),
        })) }
        expect(yield* decodeWorktreeHolderEvidence({ ...binding(mounted), json: encodeJson(value) })).toBeUndefined()
      }
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
        { ...expected, client: { ...expected.client, path: '/bin/worktree-holder-evidence' }, json },
        { ...expected, json: encodeJson({ ...evidence, kind: 'store' }) },
        { ...expected, json: encodeJson({ ...evidence, model: 'unmanaged' }) },
        { ...expected, json: encodeJson({ ...evidence, producerId: `${evidence.producerId}-other` }) },
        { ...expected, json: encodeJson({ ...evidence, scope: { ...evidence.scope, requestedPathsDigest: 'f'.repeat(64) } }) },
      ]) expect(yield* decodeWorktreeHolderEvidence(input)).toBeUndefined()
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
