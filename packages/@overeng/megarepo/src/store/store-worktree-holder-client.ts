import { createHash, randomBytes } from 'node:crypto'

import { Effect, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import type { PlatformError } from 'effect/PlatformError'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import {
  WorktreeHolderEvidenceClientConfigSchema,
  WorktreeHolderEvidenceRequestSchema,
  decodeWorktreeHolderEvidence,
  type WorktreeHolderEvidence,
  type WorktreeHolderEvidenceClientConfig,
} from './store-worktree-holder-codec.ts'

const MAX_REQUEST = 1024 * 1024
const MAX_RESPONSE = 16 * 1024 * 1024
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(WorktreeHolderEvidenceRequestSchema))

/** Check actual host/boot identity and the conservative CLOCK_BOOTTIME centisecond interval. */
export const isWorktreeHolderEvidenceFresh = (
  evidence: WorktreeHolderEvidence,
): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const machineId = yield* fs.readFile('/etc/machine-id')
    if (
      !/^[0-9a-f]{32}\n?$/u.test(new TextDecoder().decode(machineId)) ||
      createHash('sha256').update(machineId).digest('hex') !== evidence.hostId
    ) return false
    const bootBefore = (yield* fs.readFileString('/proc/sys/kernel/random/boot_id')).replace(/\n$/u, '')
    const uptime = yield* fs.readFileString('/proc/uptime')
    const bootAfter = (yield* fs.readFileString('/proc/sys/kernel/random/boot_id')).replace(/\n$/u, '')
    const match = /^([0-9]{1,20})\.([0-9]{2}) [0-9]+\.[0-9]{2}\n?$/u.exec(uptime)
    if (match === null || bootBefore !== evidence.bootId || bootAfter !== bootBefore) return false
    const lower = BigInt(match[1]!) * 1000000000n + BigInt(match[2]!) * 10000000n
    const upper = lower + 10000000n
    return BigInt(evidence.capture.finishedBootNs) <= lower &&
      upper < BigInt(evidence.capture.expiresBootNs)
  }).pipe(Effect.catch(() => Effect.succeed(false)))

const collectBounded = (stream: Stream.Stream<Uint8Array, PlatformError>, limit: number) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = []
    let length = 0
    yield* Stream.runForEach(stream, (chunk) => {
      length += chunk.byteLength
      if (length > limit) return Effect.fail(new Error('holder evidence stdout exceeds bound'))
      chunks.push(chunk)
      return Effect.void
    })
    const bytes = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return bytes
  })

/** The immutable native client alone authenticates the fixed socket; every failure is unknown. */
export const captureWorktreeHolderEvidence = ({ client, paths }: {
  readonly client: WorktreeHolderEvidenceClientConfig
  readonly paths: ReadonlyArray<string>
}): Effect.Effect<
  WorktreeHolderEvidence | undefined,
  never,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    yield* Schema.decodeEffect(WorktreeHolderEvidenceClientConfigSchema, { onExcessProperty: 'error' })(client)
    const nonce = randomBytes(16).toString('hex')
    const request = yield* Schema.decodeEffect(WorktreeHolderEvidenceRequestSchema, {
      onExcessProperty: 'error',
    })({ version: 1, nonce, kind: 'worktree', paths })
    const stdin = new TextEncoder().encode(encodeRequest(request))
    if (stdin.byteLength > MAX_REQUEST) return undefined
    const spawner = yield* ChildProcessSpawner
    const child = yield* spawner.spawn(ChildProcess.make(client.path, ['--client-v1'], {
      cwd: '/',
      env: {},
      extendEnv: false,
      shell: false,
      stdin: Stream.make(stdin),
      stdout: 'pipe',
      stderr: 'pipe',
      killSignal: 'SIGKILL',
      forceKillAfter: '100 millis',
    }))
    let stderrLength = 0
    const [stdout, , exitCode] = yield* Effect.all([
      collectBounded(child.stdout, MAX_RESPONSE),
      Stream.runForEach(child.stderr, (chunk) => {
        stderrLength += chunk.byteLength
        return stderrLength > 64 * 1024
          ? Effect.fail(new Error('holder evidence stderr exceeds bound'))
          : Effect.void
      }),
      child.exitCode,
    ], { concurrency: 3 })
    if (exitCode !== 0) return undefined
    const json = yield* Effect.try(() => new TextDecoder('utf-8', { fatal: true }).decode(stdout))
    const evidence = yield* decodeWorktreeHolderEvidence({ client, paths, nonce, json })
    if (evidence === undefined || !(yield* isWorktreeHolderEvidenceFresh(evidence))) return undefined
    return evidence
  }).pipe(
    Effect.scoped,
    Effect.timeout('25 seconds'),
    Effect.catch(() => Effect.succeed(undefined)),
  )
