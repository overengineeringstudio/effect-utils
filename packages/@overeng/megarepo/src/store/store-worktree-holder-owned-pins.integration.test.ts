import { fstatSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { expect } from 'vitest'

import { parseProcStat } from './store-inuse.ts'
import { captureDeletionIdentity, withPinnedDeletion } from './store-pinned-deletion.ts'
import { WorktreeHolderEvidenceSchema } from './store-worktree-holder-codec.ts'
import { classifyWorktreeHolderEvidence } from './store-worktree-holder-source.ts'

// Directed policy rows over real held pins, NOT an authenticated/qualified native capture.
describe.skipIf(process.platform !== 'linux')('holder policy exact native owned pins', () => {
  it.effect('exempts the actual leader pin, never task-local fd collisions or another kind',
    Effect.fnUntraced(function* () {
      const fs = yield* FileSystem.FileSystem
      const base = yield* fs.realPath(yield* fs.makeTempDirectoryScoped())
      const path = `${base}/target`
      yield* fs.makeDirectory(path)
      yield* fs.writeFileString(`${path}/sentinel`, 'retained until final guard')
      const identity = yield* captureDeletionIdentity({ rootPath: base, path })
      const start = parseProcStat(yield* fs.readFileString(`/proc/${process.pid}/stat`))?.startTime
      const uid = process.getuid?.()
      expect(start).toBeDefined()
      expect(uid).toBeDefined()
      if (start === undefined || uid === undefined) return yield* Effect.die('Missing actual process identity')
      const fixture = fileURLToPath(new URL('./fixtures/worktree-holder-evidence-v1.jsonl', import.meta.url))
      const lines = (yield* fs.readFileString(fixture)).trimEnd().split('\n')
      const template = yield* Schema.decodeEffect(Schema.fromJsonString(WorktreeHolderEvidenceSchema))(lines[0]!)
      yield* withPinnedDeletion({ rootPath: base, path, identity,
        beforeRemove: (ownedPins) => Effect.sync(() => {
          const pin = ownedPins.pins.at(-1)
          if (pin === undefined) throw new Error('Missing actual target pin')
          const actual = fstatSync(pin.fd, { bigint: true })
          const rootTemplate = template.roots[0]
          if (rootTemplate === undefined) throw new Error('Missing actual producer root template')
          const reference = {
            tgid: process.pid, leaderStart: start, tid: process.pid, taskStart: start,
            uid: [uid, uid, uid, uid] as const,
            reference: 'fd' as const, relativePath: '.',
            identity: { dev: actual.dev.toString(), ino: actual.ino.toString(), mountId: identity.at(-1)!.mountId },
            effect: 'in-use' as const, fd: pin.fd,
          }
          const evidenceFor = (references: ReadonlyArray<typeof reference>) => ({
            ...template,
            scope: { ...template.scope, complete: true },
            roots: [{ ...rootTemplate, path, identity: reference.identity, complete: true,
              referencesComplete: true, status: 'in-use' as const, unknownReasons: [], references }],
          })
          const classify = (references: ReadonlyArray<typeof reference>, ownStartTime = start) =>
            classifyWorktreeHolderEvidence({ evidence: evidenceFor(references), worktreePath: path,
              ownUid: uid, ownStartTime, ownedPins, admitted: true })
          expect(classify([reference]).inUse._tag).toBe('free')
          // Nonleader fd tables can be unshared (CLONE_FILES), even at the same fd/dev/ino.
          expect(classify([{ ...reference, tid: process.pid + 1, taskStart: `${BigInt(start) + 1n}` }]).inUse._tag).toBe('in-use')
          expect(classify([reference], `${BigInt(start) + 1n}`).inUse._tag).toBe('in-use')
          expect(classify([reference]).excludedProcesses).toEqual([])
          expect(classify([{ ...reference, fd: pin.fd + 1 }]).inUse._tag).toBe('in-use')
          expect(classify([{ ...reference, tgid: process.pid + 1, tid: process.pid + 1 }]).inUse._tag).toBe('in-use')
          for (const kind of ['cwd', 'root', 'exe', 'map', 'mount'] as const) {
            const evidence = evidenceFor([reference])
            const observed = classifyWorktreeHolderEvidence({
              evidence: { ...evidence, roots: evidence.roots.map((root) => ({
                ...root, references: [{ ...reference, reference: kind, fd: null }],
              })) }, worktreePath: path, ownUid: uid, ownStartTime: start, ownedPins, admitted: true,
            })
            expect(observed.inUse._tag).toBe('in-use')
          }
        }),
      })
      expect(yield* fs.exists(path)).toBe(false)
    }, Effect.provide(NodeServices.layer), Effect.scoped),
  )
})
