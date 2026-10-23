import { lstatSync } from 'node:fs'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import {
  GC_DELETION_RECEIPTS_RELATIVE_PATH,
  GcDeletionReceipt,
  recordGcDeletion,
  withGcPinnedDeletion,
} from './store-gc-receipts.ts'
import { captureDeletionIdentity } from './store-pinned-deletion.ts'

const decodeReceipt = Schema.decodeUnknownSync(Schema.fromJsonString(GcDeletionReceipt))

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  // A new tmpfs directory gives this test a real rename, not overlayfs EXDEV fallback.
  const rootPath = yield* fs.makeTempDirectoryScoped({ directory: '/dev/shm' })
  const path = `${rootPath}/owner/tree`
  yield* fs.makeDirectory(path, { recursive: true })
  yield* fs.writeFileString(`${path}/artifact`, 'retained on failure')
  const identity = yield* captureDeletionIdentity({ rootPath, path })
  const readReceipts = fs.readFileString(`${rootPath}/${GC_DELETION_RECEIPTS_RELATIVE_PATH}`).pipe(
    Effect.map((text) =>
      text
        .trim()
        .split('\n')
        .map((line) => decodeReceipt(line)),
    ),
  )
  return { fs, rootPath, path, identity, readReceipts }
})

describe.skipIf(process.platform !== 'linux')('GC durable deletion receipts', () => {
  for (const partial of [false, true]) {
    it.effect(
      partial === true
        ? 'persists intent before rename and partial recovery evidence'
        : 'persists intent and removed outcome',
      Effect.fnUntraced(
        function* () {
          const { fs, rootPath, path, identity, readReceipts } = yield* fixture
          let ignoredForeignProcesses = 2
          const exemptProcesses = [
            { pid: 123, startTime: '10', comm: 'systemd', rule: 'systemd-user-manager' as const },
          ]
          const result = yield* withGcPinnedDeletion({
            rootPath,
            path,
            identity,
            ignoredForeignProcesses: () => ignoredForeignProcesses,
            exemptProcesses: () => exemptProcesses,
            beforeRemove: () =>
              Effect.sync(() => {
                // The intent is persisted before the native boundary can rename the tree.
                expect(
                  lstatSync(`${rootPath}/${GC_DELETION_RECEIPTS_RELATIVE_PATH}`).size,
                ).toBeGreaterThan(0)
                ignoredForeignProcesses = 3
              }),
            afterQuarantine: (recoverPath) => {
              // The callback runs after a real quarantine rename.
              if (partial === true) lstatSync(`${recoverPath}/missing`)
            },
          }).pipe(Effect.result)
          const receipts = yield* readReceipts
          expect(receipts).toHaveLength(2)
          expect(receipts[0]!.ignoredForeignProcesses).toBe(2)
          expect(receipts[1]!.ignoredForeignProcesses).toBe(3)
          expect(receipts[0]!.exemptProcesses).toEqual(exemptProcesses)
          expect(receipts[1]!.exemptProcesses).toEqual(exemptProcesses)
          expect(receipts[0]).toMatchObject({ path, phase: 'intent', decision: 'remove' })
          expect(receipts[1]).toMatchObject({
            path,
            phase: 'outcome',
            decision: partial === true ? 'partial' : 'removed',
            attemptId: receipts[0]!.attemptId,
          })
          expect(receipts[1]!.time).toBeGreaterThanOrEqual(receipts[0]!.time)
          if (partial === true) {
            expect(result._tag).toBe('Failure')
            expect(receipts[1]!.errno).toBe('ENOENT')
            expect(receipts[1]!.recoverPath).toContain('/.mr-delete-')
            expect(yield* fs.readFileString(`${receipts[1]!.recoverPath}/target/artifact`)).toBe(
              'retained on failure',
            )
          } else {
            expect(result._tag).toBe('Success')
          }
          expect(yield* fs.exists(path)).toBe(false)
        },
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
    )
  }

  it.effect(
    'appends skipped-in-use evidence without replacing prior history',
    Effect.fnUntraced(
      function* () {
        const { rootPath, path, readReceipts } = yield* fixture
        const receipt = {
          storeBasePath: rootPath,
          path,
          phase: 'outcome' as const,
          decision: 'skipped-in-use' as const,
          reason: 'live cwd holder',
          vetoEvidence: [{ pid: 123, path }],
        }
        yield* recordGcDeletion(receipt)
        yield* recordGcDeletion(receipt)
        const receipts = yield* readReceipts
        expect(receipts).toHaveLength(2)
        expect(receipts[0]).toMatchObject({
          path,
          phase: receipt.phase,
          decision: receipt.decision,
          reason: receipt.reason,
          vetoEvidence: receipt.vetoEvidence,
        })
        expect(receipts[1]!.vetoEvidence).toEqual(receipt.vetoEvidence)
        expect(receipts[0]!.attemptId).not.toBe(receipts[1]!.attemptId)
      },
      Effect.provide(NodeServices.layer),
      Effect.scoped,
    ),
  )
})
