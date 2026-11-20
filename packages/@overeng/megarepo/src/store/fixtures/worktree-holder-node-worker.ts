import { closeSync, constants, fstatSync, openSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'

import { dlopen, FFIType } from 'bun:ffi'
import { Schema } from 'effect'

const Options = Schema.Struct({
  mode: Schema.Literals(['shared', 'unshared', 'different-fd']),
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
})
const CLONE_FILES = 0x00000400
let heldFd: number | null = null
try {
  const tid = libc.symbols.gettid()
  if (tid <= 0 || tid === process.pid) throw new Error('Worker is not a nonleader Linux task')
  const unshared = options.mode === 'unshared'
  if (unshared) {
    // Copy the real shared table, retaining the same OFDs but not KCMP_FILES identity.
    if (options.inheritedFd === null || libc.symbols.unshare(CLONE_FILES) !== 0)
      throw new Error('unshare(CLONE_FILES) failed; kernel capability is required')
    heldFd = options.inheritedFd
  } else if (options.mode === 'different-fd') {
    heldFd = openSync(options.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
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
      if (heldFd !== null) closeSync(heldFd)
      heldFd = null
      libc.close()
      port.postMessage({ sequence: request.sequence, ...state })
      port.close()
    } else {
      port.postMessage({ sequence: request.sequence, ...state })
    }
  })
} catch (error) {
  if (heldFd !== null) closeSync(heldFd)
  libc.close()
  throw error
}
