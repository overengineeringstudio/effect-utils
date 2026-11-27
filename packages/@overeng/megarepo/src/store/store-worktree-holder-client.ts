import { randomBytes } from 'node:crypto'

import { Effect, Schema, Stream } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import * as ChildProcess from 'effect/process/ChildProcess'
import { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner'

import {
  decodeWorktreeHolderEvidence,
  HolderEvidenceError,
  HolderEvidenceResponse,
  type HolderEvidenceClientConfig,
} from './store-worktree-holder-codec.ts'

const refused = () => new HolderEvidenceError({})
const encoder = new TextEncoder()
const MAX_RESPONSE = 16 * 1024 * 1024
const U64_MAX = 18446744073709551615n
const canonicalPath = (path: string) =>
  path.startsWith('/') &&
  path !== '/' &&
  encoder.encode(path).length <= 4096 &&
  path.includes('\0') === false &&
  /[\r\n\uD800-\uDFFF]/u.test(path) === false &&
  path
    .slice(1)
    .split('/')
    .every((part) => part !== '' && part !== '.' && part !== '..')
const u64 = (value: string) => /^(0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= U64_MAX
const Request = Schema.Struct({
  version: Schema.Literal(1),
  nonce: Schema.String,
  kind: Schema.Literal('worktree'),
  paths: Schema.Array(Schema.String),
})

type Target = {
  readonly path: string
  readonly identity: { readonly dev: string; readonly ino: string; readonly mountId: string }
}

/**
 * Compare a schema-validated capture with one sampled boot-clock interval.
 * @internal
 */
export const holderCaptureFitsBootWindow = ({
  capture,
  lowerBootNs,
  upperBootNs,
}: {
  readonly capture: HolderEvidenceResponse['capture']
  readonly lowerBootNs: bigint
  readonly upperBootNs: bigint
}): boolean => {
  const started = BigInt(capture.startedBootNs)
  const finished = BigInt(capture.finishedBootNs)
  const expires = BigInt(capture.expiresBootNs)
  return (
    started <= finished &&
    finished <= lowerBootNs &&
    expires > finished &&
    expires - started === 30_000_000_000n &&
    upperBootNs < expires
  )
}

/** Recheck immediately before the consumer's final action. This is not a lease or exclusion. */
export const assertWorktreeHolderEvidenceFresh = (
  response: HolderEvidenceResponse,
): Effect.Effect<void, HolderEvidenceError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    yield* Schema.decodeEffect(HolderEvidenceResponse)(response)
    if (
      response.scope.complete === false ||
      response.scope.allUids !== true ||
      response.scope.allTasks !== true ||
      response.roots.some(
        (root) =>
          !root.complete ||
          !root.referencesComplete ||
          root.status === 'unknown' ||
          root.identity === null ||
          root.unknownReasons.length !== 0,
      ) === true
    ) {
      return yield* refused()
    }
    const fs = yield* FileSystem.FileSystem
    const boot = (yield* fs.readFileString('/proc/sys/kernel/random/boot_id')).trim()
    const uptime = yield* fs.readFileString('/proc/uptime')
    const match = /^(0|[1-9][0-9]*)\.([0-9]{2}) [0-9]+\.[0-9]{2}\n?$/u.exec(uptime)
    if (boot !== response.bootId || match === null) return yield* refused()
    // /proc/uptime truncates CLOCK_BOOTTIME to centiseconds.
    const lowerBootNs = BigInt(match[1]!) * 1_000_000_000n + BigInt(match[2]!) * 10_000_000n
    const upperBootNs = lowerBootNs + 10_000_000n
    if (
      holderCaptureFitsBootWindow({ capture: response.capture, lowerBootNs, upperBootNs }) === false
    )
      return yield* refused()
  }).pipe(Effect.mapError(refused))

/**
 * Read through the caller-qualified immutable Rust producer and bind its frame to this request.
 * The normal provider owner must qualify this client configuration; path shape alone is not
 * authentication, complete host-wide absence, continuous exclusion, or mutation authority.
 */
export const readWorktreeHolderEvidence = ({
  client,
  targets,
}: {
  readonly client: HolderEvidenceClientConfig
  readonly targets: ReadonlyArray<Target>
}): Effect.Effect<
  HolderEvidenceResponse,
  HolderEvidenceError,
  FileSystem.FileSystem | ChildProcessSpawner
> =>
  Effect.gen(function* () {
    if (
      /^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+$/u.test(
        client.producerId,
      ) === false ||
      client.path !== `${client.producerId}/bin/worktree-holder-evidence` ||
      /^[0-9a-f]{64}$/u.test(client.policyId) === false ||
      targets.length === 0 ||
      targets.length > 4096 ||
      targets.some(
        ({ path, identity }) =>
          canonicalPath(path) === false ||
          u64(identity.dev) === false ||
          u64(identity.ino) === false ||
          identity.ino === '0' ||
          u64(identity.mountId) === false ||
          identity.mountId === '0',
      ) === true
    )
      return yield* refused()
    const paths = targets.map(({ path }) => path)
    if (new Set(paths).size !== paths.length) return yield* refused()
    const nonce = yield* Effect.try({ try: () => randomBytes(16).toString('hex'), catch: refused })
    const input = encoder.encode(
      yield* Schema.encodeEffect(Schema.fromJsonString(Request))({
        version: 1,
        nonce,
        kind: 'worktree',
        paths,
      }),
    )
    if (input.byteLength > 1024 * 1024) return yield* refused()
    const stdout = yield* Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        const child = yield* spawner.spawn(
          ChildProcess.make(client.path, ['--client-v1'], {
            cwd: '/',
            stdin: Stream.succeed(input),
            stdout: 'pipe',
            stderr: 'ignore',
            extendEnv: false,
            env: {},
            forceKillAfter: '1 second',
          }),
        )
        const parts: Uint8Array[] = []
        let bytes = 0
        const [, code] = yield* Effect.all(
          [
            Stream.runForEach(child.stdout, (part) => {
              bytes += part.byteLength
              if (bytes > MAX_RESPONSE) return Effect.fail(refused())
              parts.push(part)
              return Effect.void
            }),
            child.exitCode,
          ],
          { concurrency: 2 },
        )
        if (code !== 0) return yield* refused()
        return yield* Effect.try({
          try: () => {
            const decoder = new TextDecoder('utf-8', { fatal: true })
            return (
              parts.map((part) => decoder.decode(part, { stream: true })).join('') +
              decoder.decode()
            )
          },
          catch: refused,
        })
      }),
    )
    const response = yield* decodeWorktreeHolderEvidence({
      stdout,
      nonce,
      paths,
      producerId: client.producerId,
      policyId: client.policyId,
    })
    if (
      response.roots.length !== targets.length ||
      response.roots.some((root, index) => {
        const target = targets[index]!
        return (
          root.path !== target.path ||
          root.identity === null ||
          root.identity.dev !== target.identity.dev ||
          root.identity.ino !== target.identity.ino ||
          root.identity.mountId !== target.identity.mountId
        )
      }) === true
    )
      return yield* refused()
    yield* assertWorktreeHolderEvidenceFresh(response)
    return response
  }).pipe(Effect.mapError(refused))
