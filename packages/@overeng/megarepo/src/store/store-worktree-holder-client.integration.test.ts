import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import {
  assertWorktreeHolderEvidenceFresh,
  holderCaptureFitsBootWindow,
} from './store-worktree-holder-client.ts'
import { HolderEvidenceError, HolderEvidenceResponse } from './store-worktree-holder-codec.ts'

const withTestCtx = Vitest.makeWithTestCtx({ makeLayer: () => NodeServices.layer })
const producerId = `/nix/store/${'a'.repeat(32)}-worktree-holder-evidence`
const client = {
  path: `${producerId}/bin/worktree-holder-evidence`,
  producerId,
  policyId: 'a'.repeat(64),
}
const identity = { dev: '1', ino: '2', mountId: '3' }
const target = { path: '/worktrees/target', identity }
const evidence = (bootId: string, startedBootNs: string): HolderEvidenceResponse => ({
  version: 1,
  nonce: '0'.repeat(32),
  kind: 'worktree',
  producerId,
  policyId: client.policyId,
  model: 'managed-cooperative-v1',
  hostId: 'b'.repeat(64),
  bootId,
  capture: {
    startedBootNs,
    finishedBootNs: startedBootNs,
    expiresBootNs: String(BigInt(startedBootNs) + 30_000_000_000n),
  },
  scope: {
    complete: true,
    allUids: true,
    allTasks: true,
    processCount: 1,
    taskCount: 1,
    namespaces: { user: '1', pid: '2', mnt: '3', net: '4' },
    requestedPathsDigest: 'c'.repeat(64),
    digest: 'd'.repeat(64),
  },
  roots: [
    {
      ...target,
      complete: true,
      status: 'no-current-reference',
      referencesComplete: true,
      references: [],
      unknownReasons: [],
    },
  ],
})

describe('fixed holder client boundaries (not native authentication qualification)', () => {
  it.effect('refuses incomplete scope and roots without interpreting them as absence', (test) =>
    Effect.gen(function* () {
      const response = evidence('00000000-0000-4000-8000-000000000001', '1')
      for (const candidate of [
        ...['complete', 'allUids', 'allTasks'].map((key) => ({
          ...response,
          scope: { ...response.scope, [key]: false },
        })),
        ...[
          { complete: false },
          { referencesComplete: false },
          { identity: null },
          { status: 'unknown' as const },
          { unknownReasons: ['permission' as const] },
        ].map((change) => ({
          ...response,
          roots: response.roots.map((root) => ({ ...root, ...change })),
        })),
      ])
        expect(
          yield* assertWorktreeHolderEvidenceFresh(candidate).pipe(Effect.flip),
        ).toBeInstanceOf(HolderEvidenceError)
    }).pipe(withTestCtx(test)),
  )
  it.effect('keeps future and expiry checks conservative at centisecond boundaries', (test) =>
    Effect.gen(function* () {
      const lowerBootNs = 100_000_000_000n
      const upperBootNs = 100_010_000_000n
      const cases: ReadonlyArray<
        readonly [finishedBootNs: bigint, expiresBootNs: bigint, expected: boolean]
      > = [
        [lowerBootNs, lowerBootNs + 30_000_000_000n, true],
        [lowerBootNs - 1n, lowerBootNs + 30_000_000_000n - 1n, true],
        [upperBootNs, upperBootNs + 30_000_000_000n, false],
        [lowerBootNs + 1n, lowerBootNs + 30_000_000_000n + 1n, false],
        [lowerBootNs, upperBootNs, false],
        [lowerBootNs, upperBootNs + 1n, true],
      ]
      for (const [finishedBootNs, expiresBootNs, expected] of cases) {
        const startedBootNs = String(expiresBootNs - 30_000_000_000n)
        const response = yield* Schema.decodeEffect(HolderEvidenceResponse)({
          ...evidence('00000000-0000-4000-8000-000000000001', startedBootNs),
          capture: {
            startedBootNs,
            finishedBootNs: String(finishedBootNs),
            expiresBootNs: String(expiresBootNs),
          },
        })
        expect(
          holderCaptureFitsBootWindow({ capture: response.capture, lowerBootNs, upperBootNs }),
        ).toBe(expected)
      }
    }).pipe(withTestCtx(test)),
  )
  it.effect(
    'rereads real Linux boot and boottime and rejects expired, future, and other-boot evidence',
    (test) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        if (!(yield* fs.exists('/proc/sys/kernel/random/boot_id'))) {
          expect(
            yield* assertWorktreeHolderEvidenceFresh(
              evidence('00000000-0000-4000-8000-000000000001', '1'),
            ).pipe(Effect.flip),
          ).toBeInstanceOf(HolderEvidenceError)
          return
        }
        const boot = (yield* fs.readFileString('/proc/sys/kernel/random/boot_id')).trim()
        const uptime = (yield* fs.readFileString('/proc/uptime')).split(' ')[0]!
        const now = BigInt(uptime.replace('.', '')) * 10_000_000n
        const response = evidence(boot, String(now))
        yield* assertWorktreeHolderEvidenceFresh(response)
        const references: HolderEvidenceResponse['roots'][number]['references'] = [
          {
            tgid: 1,
            leaderStart: '1',
            tid: 1,
            taskStart: '1',
            uid: [0, 0, 0, 0],
            reference: 'cwd',
            relativePath: '.',
            identity,
            effect: 'in-use',
            fd: null,
          },
          {
            tgid: 1,
            leaderStart: '1',
            tid: 1,
            taskStart: '1',
            uid: [0, 0, 0, 0],
            reference: 'fd',
            relativePath: 'deleted',
            identity,
            effect: 'retained-bytes',
            fd: 4,
          },
        ]
        for (const retainedOnly of [false, true]) {
          const held: HolderEvidenceResponse = {
            ...response,
            roots: response.roots.map((root) => ({
              ...root,
              status: retainedOnly ? 'no-current-reference' : 'in-use',
              references: retainedOnly ? references.slice(1) : references,
            })),
          }
          yield* assertWorktreeHolderEvidenceFresh(held)
          expect(held.roots[0]?.references).toEqual(retainedOnly ? references.slice(1) : references)
        }
        for (const candidate of [
          evidence(boot, '0'),
          evidence(boot, String(now + 60_000_000_000n)),
          { ...response, bootId: `${boot[0] === '0' ? '1' : '0'}${boot.slice(1)}` },
          {
            ...response,
            capture: { ...response.capture, expiresBootNs: String(now + 10_000_000n) },
          },
        ]) {
          expect(
            yield* assertWorktreeHolderEvidenceFresh(candidate).pipe(Effect.flip),
          ).toBeInstanceOf(HolderEvidenceError)
        }
      }).pipe(withTestCtx(test)),
  )
})
