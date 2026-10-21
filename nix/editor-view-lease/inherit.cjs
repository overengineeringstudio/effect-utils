// Bootstrap-only: no dependency may resolve through an editor generation here.
// The launcher leases the generations reachable at launch and keeps those
// leases for the process lifetime. It does not refresh leases when a pointer
// moves later. Every root still requires complete legacy reader evidence.
'use strict'
const childProcess = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

const descriptorList = (value) => {
  if (!value) return []
  return value.split(',').map((part) => {
    if (!/^\d+$/.test(part) || Number(part) < 3) {
      throw new Error('Invalid inherited editor-view lease descriptor')
    }
    return Number(part)
  })
}
const leases = descriptorList(process.env.EDITOR_VIEW_LEASE_FDS)

// Never unlock: every inheritor shares the same open file description. Each
// process closes its own descriptors on exit, including after parent SIGKILL.
const inherit = (options = {}) => {
  if (leases.length === 0) return options
  const requested = options.stdio ?? 'pipe'
  const stdio = Array.isArray(requested) ? [...requested] : [requested, requested, requested]
  while (stdio.length < 3) stdio.push('pipe')
  const inherited = []
  for (const fd of leases) {
    inherited.push(stdio.length)
    stdio.push(fd)
  }
  return {
    ...options,
    stdio,
    env: {
      ...(options.env ?? process.env),
      EDITOR_VIEW_LEASE_FDS: inherited.join(','),
      // Child env replacement must not silently remove descriptor propagation.
      EDITOR_VIEW_LEASE_ACTIVE: process.env.EDITOR_VIEW_LEASE_ACTIVE,
      EDITOR_VIEW_LEASE_PRELOAD: __filename,
      EDITOR_VIEW_LEASE_LIBRARY: process.env.EDITOR_VIEW_LEASE_LIBRARY,
      EDITOR_VIEW_LEASE_WORKSPACE_ROOT: process.env.EDITOR_VIEW_LEASE_WORKSPACE_ROOT,
      EDITOR_VIEW_CONTENT_STORE: process.env.EDITOR_VIEW_CONTENT_STORE,
      NODE_OPTIONS: `${options.env?.NODE_OPTIONS ?? ''} --require=${__filename}`,
      BUN_OPTIONS: `${options.env?.BUN_OPTIONS ?? ''} --preload=${__filename}`,
    },
  }
}

if (leases.length > 0) {
  if (typeof Bun !== 'undefined') {
    const { closeSync } = require('node:fs')
    const { dlopen } = require('bun:ffi')
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error('Editor-view descriptor inheritance requires Linux or macOS')
    }
    const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
    if (!library || !require('node:path').isAbsolute(library)) {
      throw new Error(
        'Editor-view descriptor inheritance requires EDITOR_VIEW_LEASE_LIBRARY to name the absolute packaged native library',
      )
    }
    const native = dlopen(library, {
      eu_dupfd_cloexec: { args: ['i32', 'i32'], returns: 'i32' },
    })
    for (const method of ['spawn', 'spawnSync']) {
      const original = Bun[method].bind(Bun)
      Bun[method] = (command, options) => {
        const input = Array.isArray(command) ? { ...options, cmd: command } : command
        const { stdin = 'ignore', stdout = 'pipe', stderr = 'inherit', ...rest } = input
        const mapped = inherit({ ...rest, stdio: input.stdio ?? [stdin, stdout, stderr] })
        const temporary = []
        try {
          // Bun applies child stdio file actions in slot order. A caller's
          // "ignore"/IPC slot can close an original lease fd before its later
          // dup action. Copy sources above every target slot first, so no file
          // action can overwrite/close them before the lease mapping completes.
          const firstLeaseSlot = mapped.stdio.length - leases.length
          const minimum = mapped.stdio.length + (input.ipc ? 1 : 0)
          for (let index = 0; index < leases.length; index++) {
            const fd = native.symbols.eu_dupfd_cloexec(leases[index], minimum)
            if (fd < 0) throw new Error('Cannot duplicate editor-view lease before spawning child')
            temporary.push(fd)
            mapped.stdio[firstLeaseSlot + index] = fd
          }
          return original(mapped)
        } finally {
          // Close only our temporary copies, never LOCK_UN the shared open
          // descriptions. The actual child retains its mapped descriptors.
          for (const fd of temporary) closeSync(fd)
        }
      }
    }
  } else {
    // Node's async entrypoints (including execFile/fork) converge here.
    // Bun's node:child_process implementation instead converges on Bun.spawn
    // above, so mapping there avoids duplicating every inherited descriptor.
    const spawn = childProcess.ChildProcess.prototype.spawn
    childProcess.ChildProcess.prototype.spawn = function (options) {
      const env = Object.fromEntries(
        (options.envPairs ?? []).map((pair) => {
          const equals = pair.indexOf('=')
          return [pair.slice(0, equals), pair.slice(equals + 1)]
        }),
      )
      const mapped = inherit({ ...options, env })
      return spawn.call(this, {
        ...mapped,
        envPairs: Object.entries(mapped.env)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => `${key}=${value}`),
      })
    }
    const spawnSync = childProcess.spawnSync
    childProcess.spawnSync = (command, args, options) =>
      Array.isArray(args)
        ? spawnSync(command, args, inherit(options))
        : spawnSync(command, inherit(args))
    const execFileSync = childProcess.execFileSync
    childProcess.execFileSync = (command, args, options) =>
      Array.isArray(args)
        ? execFileSync(command, args, inherit(options))
        : execFileSync(command, inherit(args))
    const execSync = childProcess.execSync
    childProcess.execSync = (command, options) => execSync(command, inherit(options))
    syncBuiltinESMExports()
  }
}
