import { lstat, readFile, readlink } from 'node:fs/promises'
import { Socket } from 'node:net'
import { endianness } from 'node:os'
import { dirname, posix } from 'node:path'

import { DateTime, Effect, Schema } from 'effect'

import {
  CensusRequest,
  CensusResponse,
  CensusStamp,
  CensusUnavailable,
} from './store-demand-census-wire.ts'

const ENDPOINT = '/run/megarepo-workspace-activity/census-v1.sock'
const REQUEST_BYTES = 64 * 1024
const RESPONSE_BYTES = 4 * 1024 * 1024
const RPC_NS = 12_000_000_000n
const unavailable = (reason: CensusUnavailable['reason'], details?: string) =>
  new CensusUnavailable({ reason, ...(details === undefined ? {} : { details }) })

interface CensusNative {
  readonly clock_gettime: (clock: number, time: BigInt64Array) => number
  readonly socket: (domain: number, type: number, protocol: number) => number
  readonly connect: (fd: number, address: Uint8Array, length: number) => number
  readonly getsockopt: (
    fd: number,
    level: number,
    option: number,
    value: Int32Array,
    length: Uint32Array,
  ) => number
  readonly close: (fd: number) => number
}

// Lazy, as with git-writer-lock: Node consumers can import the module, but cannot
// accidentally substitute process-relative hrtime for Linux CLOCK_MONOTONIC.
const loadNative = async (): Promise<CensusNative> => {
  if (
    process.platform !== 'linux' ||
    !['x64', 'arm64'].includes(process.arch) ||
    endianness() !== 'LE'
  ) {
    throw unavailable('unsupported-platform')
  }
  const { dlopen } = await import('bun:ffi')
  return dlopen('libc.so.6', {
    clock_gettime: { args: ['i32', 'ptr'], returns: 'i32' },
    socket: { args: ['i32', 'i32', 'i32'], returns: 'i32' },
    connect: { args: ['i32', 'ptr', 'u32'], returns: 'i32' },
    getsockopt: { args: ['i32', 'i32', 'i32', 'ptr', 'ptr'], returns: 'i32' },
    close: { args: ['i32'], returns: 'i32' },
  }).symbols
}
let nativePromise: Promise<CensusNative> | undefined
const native = () => (nativePromise ??= loadNative())
const monotonic = (lib: CensusNative): bigint => {
  const buffer = new BigInt64Array(2)
  if (
    lib.clock_gettime(1, buffer) !== 0 ||
    buffer[0]! < 0n ||
    buffer[1]! < 0n ||
    buffer[1]! >= 1_000_000_000n
  ) {
    throw unavailable('io', 'CLOCK_MONOTONIC unavailable')
  }
  return buffer[0]! * 1_000_000_000n + buffer[1]!
}
const classify = (reason: CensusUnavailable['reason']) => (cause: unknown) =>
  cause instanceof CensusUnavailable ? cause : unavailable(reason)

export const readCensusMonotonicNs: Effect.Effect<bigint, CensusUnavailable> = Effect.tryPromise({
  try: async () => monotonic(await native()),
  catch: classify('unsupported-platform'),
})

const checkEndpoint = async (path: string) => {
  if (!posix.isAbsolute(path) || posix.normalize(path) !== path || path.includes('\0')) {
    throw unavailable('authentication', 'Noncanonical endpoint')
  }
  const socket = await lstat(path, { bigint: true })
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0n) {
    throw unavailable('authentication', 'Endpoint is not a root-owned socket')
  }
  let directory = dirname(path)
  for (;;) {
    const info = await lstat(directory, { bigint: true })
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0n ||
      (info.mode & 0o022n) !== 0n
    ) {
      throw unavailable('authentication', 'Endpoint directory is not root-controlled')
    }
    if (directory === '/') break
    directory = dirname(directory)
  }
  return socket
}

const checkNamespaces = async () => {
  // The root-authenticated responder supplies host CLOCK_MONOTONIC. Prove our
  // own clock has zero offset from that clock without ptrace-gated peer reads.
  const uidMap = (await readFile('/proc/self/uid_map', 'utf8')).trim().split(/\s+/)
  if (uidMap.join(' ') !== '0 0 4294967295')
    throw unavailable('namespace', 'Translated user namespace')
  // Linux exposes time_ns_for_children offsets here, not time_ns offsets.
  // They prove the active clock only when both of our namespace links agree.
  const [active, children] = await Promise.all([
    readlink('/proc/self/ns/time'),
    readlink('/proc/self/ns/time_for_children'),
  ])
  if (active !== children)
    throw unavailable('namespace', 'Active time namespace offsets are unknown')
  const offsets = (await readFile('/proc/self/timens_offsets', 'utf8')).trim().split('\n')
  if (
    offsets.length !== 2 ||
    !/^monotonic\s+0\s+0$/.test(offsets[0]!.trim()) ||
    !/^boottime\s+0\s+0$/.test(offsets[1]!.trim())
  ) {
    throw unavailable('namespace', 'Unknown time namespace offsets')
  }
}

/** One authenticated connection, one bounded frame, and EOF before admission. */
export const requestCensus = Effect.fn('store/demand-census/request')(function* ({
  request,
  deadlineNs,
  socketPath = ENDPOINT,
}: {
  readonly request: CensusRequest
  readonly deadlineNs: bigint
  /** Scoped caller-test override only; endpoint and peer authentication remain mandatory. */
  readonly socketPath?: string
}): Effect.fn.Return<
  { readonly response: CensusResponse; readonly receivedAt: CensusStamp },
  CensusUnavailable
> {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(CensusRequest))(request).pipe(
    Effect.mapError(() => unavailable('request')),
  )
  const payload = Buffer.from(encoded, 'utf8')
  if (payload.length === 0 || payload.length > REQUEST_BYTES)
    return yield* unavailable('request', 'Request frame exceeds bound')
  const lib = yield* Effect.tryPromise({ try: native, catch: classify('unsupported-platform') })
  const startedAt = yield* readCensusMonotonicNs
  const rpcDeadline = deadlineNs < startedAt + RPC_NS ? deadlineNs : startedAt + RPC_NS
  if (rpcDeadline <= startedAt) return yield* unavailable('deadline')

  return yield* Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(
        Effect.try({
          try: () => {
            // Nonblocking connect never waits on a saturated AF_UNIX accept queue.
            // A not-immediately-connectable endpoint fails closed; there is no retry.
            const fd = lib.socket(1, 1 | 0o4000 | 0o2000000, 0)
            if (fd < 0) throw unavailable('connection')
            const connection: { readonly fd: number; stream: Socket | undefined } = {
              fd,
              stream: undefined,
            }
            return connection
          },
          catch: classify('connection'),
        }),
        ({ fd, stream }) =>
          Effect.sync(() => {
            if (stream === undefined) lib.close(fd)
            else stream.destroy()
          }),
      )
      // All asynchronous preparation is abortable under the same absolute deadline.
      return yield* Effect.callback<
        { readonly response: CensusResponse; readonly receivedAt: CensusStamp },
        CensusUnavailable
      >((resume) => {
        let finished = false
        let timer: ReturnType<typeof setTimeout> | undefined
        let writeTimer: ReturnType<typeof setTimeout> | undefined
        const finish = (
          result: Effect.Effect<
            { readonly response: CensusResponse; readonly receivedAt: CensusStamp },
            CensusUnavailable
          >,
        ) => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          clearTimeout(writeTimer)
          resume(result)
        }
        const fail = (error: CensusUnavailable) => finish(Effect.fail(error))
        const checkDeadline = () => {
          try {
            const remaining = rpcDeadline - monotonic(lib)
            if (remaining <= 0n) {
              fail(unavailable('deadline'))
              return
            }
            timer = setTimeout(checkDeadline, Math.max(1, Math.ceil(Number(remaining) / 1_000_000)))
          } catch {
            fail(unavailable('io'))
          }
        }
        checkDeadline()
        void (async () => {
          try {
            const before = await checkEndpoint(socketPath)
            if (finished) return
            const path = Buffer.from(`${socketPath}\0`, 'utf8')
            if (path.length > 108)
              throw unavailable('connection', 'Endpoint path exceeds sockaddr_un')
            const address = Buffer.alloc(2 + path.length)
            address.writeUInt16LE(1, 0)
            path.copy(address, 2)
            if (lib.connect(socket.fd, address, address.length) !== 0)
              throw unavailable('connection')
            const requestDeadline = monotonic(lib) + 1_000_000_000n
            const credentials = new Int32Array(3)
            const size = new Uint32Array([12])
            if (
              lib.getsockopt(socket.fd, 1, 17, credentials, size) !== 0 ||
              size[0] !== 12 ||
              credentials[0]! <= 0 ||
              credentials[1] !== 0
            ) {
              throw unavailable('authentication', 'Responder is not kernel-authenticated UID 0')
            }
            await checkNamespaces()
            const after = await checkEndpoint(socketPath)
            if (before.dev !== after.dev || before.ino !== after.ino)
              throw unavailable('authentication', 'Endpoint changed during connection')
            if (finished) return
            const stream = new Socket({
              fd: socket.fd,
              readable: true,
              writable: true,
              allowHalfOpen: true,
            })
            socket.stream = stream
            stream.on('error', () => fail(unavailable('connection')))
            const header = Buffer.alloc(4)
            let headerBytes = 0
            let body: Buffer | undefined
            let bodyBytes = 0
            stream.on('data', (chunk: Buffer) => {
              if (finished) return
              let offset = 0
              if (headerBytes < 4) {
                const length = Math.min(4 - headerBytes, chunk.length)
                chunk.copy(header, headerBytes, 0, length)
                headerBytes += length
                offset += length
                if (headerBytes === 4) {
                  const length = header.readUInt32BE(0)
                  if (length === 0 || length > RESPONSE_BYTES) {
                    fail(unavailable('framing', 'Declared response length exceeds bound'))
                    return
                  }
                  body = Buffer.alloc(length)
                }
              }
              if (body === undefined) return
              if (chunk.length - offset > body.length - bodyBytes) {
                fail(unavailable('framing', 'Extra response bytes'))
                return
              }
              chunk.copy(body, bodyBytes, offset)
              bodyBytes += chunk.length - offset
            })
            stream.on('end', () => {
              if (finished) return
              try {
                if (body === undefined || bodyBytes !== body.length)
                  throw unavailable('framing', 'Short response frame')
                const receivedNs = monotonic(lib)
                if (receivedNs > rpcDeadline) throw unavailable('deadline')
                const json = new TextDecoder('utf-8', { fatal: true }).decode(body)
                const response = Schema.decodeUnknownSync(Schema.fromJsonString(CensusResponse), {
                  onExcessProperty: 'error',
                })(json)
                if (monotonic(lib) > rpcDeadline) throw unavailable('deadline')
                finish(
                  Effect.succeed({
                    response,
                    receivedAt: {
                      monotonicNs: receivedNs.toString(),
                      wall: DateTime.makeUnsafe(Date.now()),
                    },
                  }),
                )
              } catch (cause) {
                fail(classify('response')(cause))
              }
            })
            stream.on('close', () => {
              if (!finished) fail(unavailable('framing', 'Disconnected response'))
            })
            const beforeWrite = monotonic(lib)
            if (beforeWrite >= rpcDeadline || beforeWrite >= requestDeadline)
              throw unavailable('deadline')
            writeTimer = setTimeout(
              () => fail(unavailable('deadline', 'Request frame write timed out')),
              Math.max(1, Math.ceil(Number(requestDeadline - beforeWrite) / 1_000_000)),
            )
            stream.once('finish', () => {
              clearTimeout(writeTimer)
              try {
                if (monotonic(lib) >= requestDeadline) fail(unavailable('deadline'))
              } catch {
                fail(unavailable('io'))
              }
            })
            const requestHeader = Buffer.alloc(4)
            requestHeader.writeUInt32BE(payload.length)
            stream.write(requestHeader)
            stream.end(payload)
            stream.resume()
          } catch (cause) {
            fail(classify('io')(cause))
          }
        })()
        return Effect.sync(() => {
          finished = true
          clearTimeout(timer)
          clearTimeout(writeTimer)
          socket.stream?.destroy()
        })
      })
    }),
  )
})
