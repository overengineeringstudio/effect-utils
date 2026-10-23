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
const leaseEnvironment = (env, descriptors) => ({
  ...env,
  EDITOR_VIEW_LEASE_FDS: descriptors.join(','),
  // Child env replacement must not silently remove descriptor propagation.
  EDITOR_VIEW_LEASE_ACTIVE: process.env.EDITOR_VIEW_LEASE_ACTIVE,
  EDITOR_VIEW_LEASE_PRELOAD: __filename,
  EDITOR_VIEW_LEASE_LIBRARY: process.env.EDITOR_VIEW_LEASE_LIBRARY,
  EDITOR_VIEW_LEASE_WORKSPACE_ROOT: process.env.EDITOR_VIEW_LEASE_WORKSPACE_ROOT,
  EDITOR_VIEW_CONTENT_STORE: process.env.EDITOR_VIEW_CONTENT_STORE,
  NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --require=${__filename}`,
  BUN_OPTIONS: `${env.BUN_OPTIONS ?? ''} --preload=${__filename}`,
})

// Never unlock: every inheritor shares the same open file description. Each
// process closes its own descriptors on exit, including after parent SIGKILL.
const inherit = (options = {}) => {
  if (leases.length === 0) return options
  const env = options.env ?? process.env
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
    env: leaseEnvironment(env, inherited),
  }
}

if (leases.length > 0) {
  if (typeof Bun !== 'undefined') {
    const { closeSync, fstatSync } = require('node:fs')
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      throw new Error('Editor-view descriptor inheritance requires Linux or macOS')
    }
    const library = process.env.EDITOR_VIEW_LEASE_LIBRARY
    if (!library || !require('node:path').isAbsolute(library)) {
      throw new Error(
        'Editor-view descriptor inheritance requires EDITOR_VIEW_LEASE_LIBRARY to name the absolute packaged native library',
      )
    }
    // Leaf readers only retain inherited fds. Compiling a Bun FFI binding in
    // every leaf adds startup work even when no descendant is ever spawned.
    let native
    let ffi
    const binding = () => {
      if (native === undefined) {
        ffi = require('bun:ffi')
        native = ffi.dlopen(library, {
          eu_dupfd_cloexec: { args: ['i32', 'i32'], returns: 'i32' },
          eu_execve: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'i32', 'ptr'], returns: 'i32' },
        })
      }
      return native.symbols
    }
    const validMapping = leases.every((fd) => {
      try {
        fstatSync(fd)
        return true
      } catch {
        return false
      }
    })
    if (
      process.env.EDITOR_VIEW_LEASE_ACTIVE === '1' &&
      validMapping &&
      process.execve !== undefined
    ) {
      const { getSystemErrorName, getSystemErrorMessage } = require('node:util')
      const execve = process.execve.bind(process)
      // Bun's process.execve deliberately closes fds > 2 on both platforms.
      // Preserve only the mapped leases across replacement, with the same
      // numbers and open file descriptions: reacquiring after exec has a gap.
      process.execve = (file, args = [], env = process.env) => {
        // Delegate only guaranteed-invalid inputs to Bun's own validator.
        // Native exec errors below must never fall back to an unleased exec.
        if (
          typeof file !== 'string' ||
          file.includes('\0') ||
          !Array.isArray(args) ||
          env === null ||
          typeof env !== 'object'
        )
          return execve(file, args, env)
        args = [...args]
        if (args.some((value) => typeof value !== 'string' || value.includes('\0')))
          return execve(file, args, env)
        const entries = Object.entries(env).filter(([, value]) => value !== undefined)
        env = Object.fromEntries(entries)
        if (
          entries.some(
            ([key, value]) =>
              key.includes('\0') || typeof value !== 'string' || value.includes('\0'),
          )
        )
          return execve(file, args, env)
        const symbols = binding()
        const strings = (values) => values.map((value) => Buffer.from(`${value}\0`))
        const pointers = (values) =>
          new BigUint64Array([...values.map((value) => BigInt(ffi.ptr(value))), 0n])
        const argv = strings(args)
        const environment = strings(
          Object.entries(leaseEnvironment(Object.fromEntries(entries), leases))
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => `${key}=${value}`),
        )
        const restoration = new Int32Array(2)
        const error = symbols.eu_execve(
          Buffer.from(`${file}\0`),
          pointers(argv),
          pointers(environment),
          new Int32Array(leases),
          leases.length,
          restoration,
        )
        const code = getSystemErrorName(-error)
        const message = getSystemErrorMessage(-error)
        const restorationMessage =
          restoration[1] === 0
            ? ''
            : `; cannot restore fd ${restoration[0]} flags: ${getSystemErrorName(-restoration[1])}`
        throw Object.assign(
          new Error(
            `${code}, ${message[0].toUpperCase()}${message.slice(1)} '${file}'${restorationMessage}`,
          ),
          {
            errno: error,
            code,
            syscall: 'execve',
            path: file,
            ...(restoration[1] === 0
              ? {}
              : {
                  descriptorRestorationError: { fd: restoration[0], errno: restoration[1] },
                }),
          },
        )
      }
    }
    for (const method of ['spawn', 'spawnSync']) {
      const original = Bun[method].bind(Bun)
      Bun[method] = (command, options) => {
        const input = Array.isArray(command) ? { ...options, cmd: command } : command
        const { stdin = 'ignore', stdout = 'pipe', stderr = 'inherit', ...rest } = input
        const mapped = inherit({ ...rest, stdio: input.stdio ?? [stdin, stdout, stderr] })
        const temporary = []
        try {
          const symbols = binding()
          // Bun applies child stdio file actions in slot order. A caller's
          // "ignore"/IPC slot can close an original lease fd before its later
          // dup action. Copy sources above every target slot first, so no file
          // action can overwrite/close them before the lease mapping completes.
          const firstLeaseSlot = mapped.stdio.length - leases.length
          const minimum = mapped.stdio.length + (input.ipc ? 1 : 0)
          for (let index = 0; index < leases.length; index++) {
            const fd = symbols.eu_dupfd_cloexec(leases[index], minimum)
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
