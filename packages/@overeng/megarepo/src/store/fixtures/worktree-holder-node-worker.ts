import { closeSync, constants, fstatSync, openSync, unlinkSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

import { dlopen, FFIType, ptr } from 'bun:ffi'
import { Schema } from 'effect'

const Options = Schema.Struct({
  mode: Schema.Literals(['shared', 'unshared', 'different-fd', 'detached-file', 'detached-dir', 'nested-unlinked', 'overlay-file']),
  root: Schema.String,
  inheritedFd: Schema.NullOr(Schema.Int),
})
const Command = Schema.Struct({ sequence: Schema.Int, command: Schema.Literals(['inspect', 'stop']) })
const options = Schema.decodeUnknownSync(Options)(workerData)
const port = parentPort
if (port === null) throw new Error('Fixture must run as a real worker')
const libc = dlopen('libc.so.6', {
  gettid: { args: [], returns: FFIType.i32 },
  unshare: { args: [FFIType.i32], returns: FFIType.i32 },
  memfd_create: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  mmap: {
    args: [FFIType.ptr, FFIType.u64, FFIType.i32, FFIType.i32, FFIType.i32, FFIType.i64],
    returns: FFIType.i64,
  },
  munmap: { args: [FFIType.i64, FFIType.u64], returns: FFIType.i32 },
})
const CLONE_FILES = 0x00000400
let heldFd: number | null = null
let internalFd: number | undefined
let sharedMapping: bigint | undefined
const closeResources = () => {
  if (heldFd !== null) { closeSync(heldFd); heldFd = null }
  if (internalFd !== undefined) { closeSync(internalFd); internalFd = undefined }
  if (sharedMapping !== undefined) {
    if (libc.symbols.munmap(sharedMapping, 4096) !== 0) throw new Error('munmap failed')
    sharedMapping = undefined
  }
}
try {
  const tid = libc.symbols.gettid()
  if (tid <= 0 || tid === process.pid) throw new Error('Worker is not a nonleader Linux task')
  // Real kernel internal shmem objects, retained throughout both captures.
  const name = new TextEncoder().encode('holder-vm-worker\0')
  const internal = libc.symbols.memfd_create(ptr(name), 1)
  if (internal < 0) throw new Error('memfd_create failed')
  internalFd = internal
  // MAP_SHARED | MAP_ANONYMOUS; i64 preserves the exact pointer bits at this ABI boundary.
  const mapping = libc.symbols.mmap(null, 4096, 3, 0x21, -1, 0n)
  if (mapping === -1n) throw new Error('shared anonymous mmap failed')
  sharedMapping = mapping
  const unshared = options.mode === 'unshared'
  if (unshared) {
    // Copy the real shared table, retaining the same OFDs but not KCMP_FILES identity.
    if (options.inheritedFd === null || libc.symbols.unshare(CLONE_FILES) !== 0)
      throw new Error('unshare(CLONE_FILES) failed; kernel capability is required')
    heldFd = options.inheritedFd
  } else if (options.mode === 'different-fd') {
    heldFd = openSync(options.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  } else if (options.mode === 'nested-unlinked') {
    const path = `${options.root}/submount/held`
    heldFd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600)
    unlinkSync(path)
  } else if (options.mode === 'detached-file' || options.mode === 'detached-dir' || options.mode === 'overlay-file') {
    const path = `/run/holder-negative-${options.mode}/held`
    heldFd = openSync(path, constants.O_RDONLY |
      (options.mode === 'detached-dir' ? constants.O_DIRECTORY : 0) | constants.O_NOFOLLOW)
    if (options.mode === 'detached-file') unlinkSync(path)
  }
  let stopped = false
  const inspect = () => {
    const stat = heldFd === null ? undefined : fstatSync(heldFd, { bigint: true })
    return {
      tid: libc.symbols.gettid(),
      fd: heldFd,
      unshared,
      dev: stat?.dev.toString() ?? null,
      ino: stat?.ino.toString() ?? null,
      links: stat?.nlink.toString() ?? null,
      internal: internalFd === undefined ? null : {
        fd: internalFd,
        dev: fstatSync(internalFd, { bigint: true }).dev.toString(),
        links: fstatSync(internalFd, { bigint: true }).nlink.toString(),
        sharedMapping: sharedMapping !== undefined,
      },
    }
  }
  // Keep an actual pending command loop throughout both authenticated captures.
  port.on('message', (input: unknown) => {
    const request = Schema.decodeUnknownSync(Command)(input)
    if (stopped) throw new Error('Command after worker shutdown')
    const state = inspect()
    if (state.tid !== tid) throw new Error('Worker task identity changed')
    if (request.command === 'stop') {
      stopped = true
      closeResources()
      libc.close()
      port.postMessage({ sequence: request.sequence, ...state })
      port.close()
    } else {
      port.postMessage({ sequence: request.sequence, ...state })
    }
  })
} catch (error) {
  closeResources()
  libc.close()
  throw error
}
