import { closeSync, constants, lstatSync, openSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { parseArgs } from 'node:util'
import { Worker } from 'node:worker_threads'

import { NodeServices } from '@effect/platform-node'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { captureDeletionIdentity, withPinnedDeletion } from '../store-pinned-deletion.ts'
import { captureWorktreeHolderEvidence } from '../store-worktree-holder-client.ts'
import { WorktreeHolderEvidenceClientConfigSchema } from '../store-worktree-holder-codec.ts'
import { makeWorktreeHolderSource } from '../store-worktree-holder-source.ts'

const WorkerReply = Schema.Struct({
  sequence: Schema.Int,
  tid: Schema.Int,
  fd: Schema.NullOr(Schema.Int),
  unshared: Schema.Boolean,
  dev: Schema.NullOr(Schema.String),
  ino: Schema.NullOr(Schema.String),
})
const Mode = Schema.Literals(['shared', 'unshared', 'different-fd'])
const parent = '/var/lib/holder-fixture'
const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
  if (!condition) throw new Error(message)
}

const main = Effect.gen(function* () {
  const { values } = parseArgs({
    options: {
      client: { type: 'string' },
      'producer-id': { type: 'string' },
      'policy-id': { type: 'string' },
      root: { type: 'string' },
      mode: { type: 'string' },
      worker: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  })
  const mode = Schema.decodeUnknownSync(Mode)(values.mode)
  const client = Schema.decodeUnknownSync(WorktreeHolderEvidenceClientConfigSchema, {
    onExcessProperty: 'error',
  })({ path: values.client, producerId: values['producer-id'], policyId: values['policy-id'] })
  const root = values.root
  const workerPath = values.worker
  assert(process.platform === 'linux' && process.versions.bun !== undefined, 'Linux Bun required')
  assert(process.getuid?.() === 1000, 'Consumer must run as actual UID 1000')
  assert(root !== undefined && isAbsolute(root) && normalize(root) === root && dirname(root) === parent,
    'Root must be a fresh canonical direct child of /var/lib/holder-fixture')
  assert(workerPath !== undefined && isAbsolute(workerPath), 'Absolute worker path required')
  const fs = yield* FileSystem.FileSystem
  assert((yield* fs.realPath(parent)) === parent, 'Fixture parent must not be a symlink')
  assert(lstatSync(parent).uid === 1000, 'Fixture parent must belong to UID 1000')
  for (const outside of [process.cwd(), process.execPath, workerPath]) {
    const actual = yield* fs.realPath(outside)
    assert(actual !== root && !actual.startsWith(`${root}/`), 'Runtime must be outside disposable root')
  }
  // Exclusive mkdir: never adopt or remove a pre-existing directory supplied by a caller.
  yield* fs.makeDirectory(root)
  yield* fs.writeFileString(`${root}/payload`, 'disposable holder integration payload\n')
  const identity = yield* captureDeletionIdentity({ rootPath: parent, path: root })
  const veto = new Error('Actual holder source vetoed physical removal')
  let vetoed = false
  let report: Record<string, unknown> = {}
  yield* withPinnedDeletion({
    rootPath: parent,
    path: root,
    identity,
    beforeRemove: (ownedPins) => Effect.scoped(Effect.gen(function* () {
      const session = yield* Effect.acquireRelease(
        Effect.tryPromise(async () => {
          let extra: number | undefined
          let worker: Worker | undefined
          try {
            if (mode === 'unshared')
              extra = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
            worker = new Worker(workerPath, { workerData: { mode, root, inheritedFd: extra ?? null } })
            const activeWorker = worker
            let sequence = 0
            let failure: Error | undefined
            activeWorker.on('error', (error) => { failure = error })
            activeWorker.on('exit', (code) => { failure ??= new Error(`Worker exited (${code})`) })
            const ask = (command: 'inspect' | 'stop') => {
              const { promise, resolve, reject } = Promise.withResolvers<typeof WorkerReply.Type>()
              if (failure !== undefined) { reject(failure); return promise }
              const id = ++sequence
              const finish = () => {
                clearTimeout(timer)
                activeWorker.off('message', onMessage)
                activeWorker.off('error', onError)
                activeWorker.off('exit', onExit)
              }
              const onError = (error: Error) => { finish(); reject(error) }
              const onExit = (code: number) => onError(new Error(`Worker exited before reply (${code})`))
              const onMessage = (input: unknown) => {
                try {
                  const reply = Schema.decodeUnknownSync(WorkerReply, { onExcessProperty: 'error' })(input)
                  assert(reply.sequence === id, 'Worker reply sequence changed')
                  finish()
                  resolve(reply)
                } catch (error) { finish(); reject(error) }
              }
              const timer = setTimeout(() => onError(new Error('Worker command timed out')), 10000)
              activeWorker.on('message', onMessage)
              activeWorker.once('error', onError)
              activeWorker.once('exit', onExit)
              activeWorker.postMessage({ sequence: id, command })
              return promise
            }
            const ready = await ask('inspect')
            assert(ready.tid > 0 && ready.tid !== process.pid, 'Real nonleader worker TID required')
            assert(ready.unshared === (mode === 'unshared'), 'Worker table mode mismatch')
            if (mode === 'unshared') assert(ready.fd === extra, 'Worker did not inherit leader extra fd')
            // Only this independent extra fd closes; engine-owned descriptors remain untouched.
            if (extra !== undefined) { closeSync(extra); extra = undefined }
            return { worker: activeWorker, ready, ask }
          } catch (error) {
            if (worker !== undefined) await worker.terminate()
            throw error
          } finally {
            if (extra !== undefined) closeSync(extra)
          }
        }),
        (session) => Effect.promise(async () => {
          try { await session.ask('stop') } finally { await session.worker.terminate() }
        }),
      )
      const worker = session.ready
      assert(yield* fs.exists(`/proc/${process.pid}/task/${worker.tid}`), 'Worker task vanished')
      const before = yield* Effect.tryPromise(() => session.ask('inspect'))
      assert(before.tid === worker.tid, 'Worker identity changed before capture')
      const evidence = yield* captureWorktreeHolderEvidence({ client, paths: [root] })
      assert(evidence !== undefined, 'Authenticated strict capture failed or expired (UNKNOWN)')
      const captured = evidence.roots[0]
      assert(captured !== undefined && evidence.scope.complete && captured.complete &&
        captured.referencesComplete && captured.status !== 'unknown' && captured.unknownReasons.length === 0,
        'Actual producer coverage is UNKNOWN')
      const refs = captured.references.filter((reference) => reference.tgid === process.pid &&
        reference.tid === worker.tid && reference.reference === 'fd')
      assert(refs.length > 0, 'Producer did not observe actual worker target descriptors')
      if (mode === 'shared') {
        assert(worker.fd === null, 'Shared worker unexpectedly owns an independent target fd')
        assert(refs.every((reference) => ownedPins.has({
          kind: 'fd', pid: reference.tid, fd: reference.fd,
          dev: reference.identity.dev, ino: reference.identity.ino, alias: reference.leaderFdAlias,
        })), 'Actual shared-worker references lack exact producer alias proof to minted pins')
      } else {
        assert(worker.fd !== null && !ownedPins.pins.some((pin) => pin.fd === worker.fd),
          'Held target fd must not be an engine-minted fd')
        const retained = refs.find((reference) => reference.fd === worker.fd &&
          reference.identity.dev === worker.dev && reference.identity.ino === worker.ino)
        assert(retained !== undefined, 'Actual worker-held independent target fd was not observed')
        assert(!ownedPins.has({ kind: 'fd', pid: retained.tid, fd: retained.fd,
          dev: retained.identity.dev, ino: retained.identity.ino, alias: retained.leaderFdAlias }),
          'Independent worker descriptor incorrectly received owned-pin authority')
        if (mode === 'unshared')
          assert(refs.every((reference) => reference.leaderFdAlias === undefined),
            'Unshared fd table incorrectly received same-table alias proof')
      }
      // This second fresh capture is the real source policy used by the native deletion callback.
      const source = yield* makeWorktreeHolderSource({ client, paths: [root] })
      const observation = yield* source.read({ worktreePath: root, ownedPins })
      const after = yield* Effect.tryPromise(() => session.ask('inspect'))
      assert(after.tid === worker.tid && after.fd === worker.fd && after.dev === worker.dev &&
        after.ino === worker.ino, 'Worker did not retain its actual descriptor through fresh capture')
      assert(observation.complete && observation.inUse._tag !== 'unknown', 'Source returned UNKNOWN')
      assert(observation.excludedProcesses.length === 0, 'Unexpected process-wide exclusion')
      assert(observation.inUse._tag === (mode === 'shared' ? 'free' : 'in-use'),
        'Actual holder-source decision does not match mode')
      if (mode !== 'shared') assert(observation.references.some((reference) =>
        reference.pid === process.pid && reference.kind === 'fd' && reference.path === root),
        'Source lost actual retained target fd veto')
      report = { mode, root, worker, pins: ownedPins.pins, observation,
        evidence: { producerId: evidence.producerId, policyId: evidence.policyId,
          capture: evidence.capture, scope: evidence.scope, root: captured } }
      if (mode !== 'shared') return yield* Effect.fail(veto)
    })),
  }).pipe(Effect.catch((error) => {
    if (error !== veto) return Effect.fail(error)
    vetoed = true
    return Effect.void
  }))
  const exists = yield* fs.exists(root)
  assert(report.mode === mode, 'No real beforeRemove observation was produced')
  assert(mode === 'shared' ? !exists && !vetoed : exists && vetoed, 'Physical deletion violated mode')
  if (mode !== 'shared') assert((yield* fs.readFileString(`${root}/payload`)) ===
    'disposable holder integration payload\n', 'Veto did not preserve payload')
  return { ...report, removed: !exists }
})

try {
  const result = await Effect.runPromise(main.pipe(Effect.provide(NodeServices.layer), Effect.scoped))
  // No environment, stderr from the privileged client, or fabricated evidence is emitted.
  process.stdout.write(`${JSON.stringify(result)}\n`)
} catch (error) {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
}
