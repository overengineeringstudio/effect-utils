import { dlopen } from 'bun:ffi'
import { execFile, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

const managedBegin = '# BEGIN effect-utils file watcher admission'
const managedEnd = '# END effect-utils file watcher admission'

/** Keep explicit local providers and the independently managed cache overlay intact. */
export const withoutManagedWatcherBlock = (current: string): string => {
  const output: string[] = []
  let inside = false
  let found = false
  for (const line of current.split(/\r?\n/u)) {
    if (line === managedBegin) {
      if (inside === true || found === true) throw new Error('duplicate managed file watcher block')
      inside = true
      found = true
    } else if (line === managedEnd) {
      if (inside === false) throw new Error('unmatched managed file watcher block end')
      inside = false
    } else if (inside === false) output.push(line)
  }
  if (inside === true) throw new Error('unterminated managed file watcher block')
  return output.join('\n').trimEnd()
}

/** The initial native daemon reads its watcher from this file, not CLI overrides. */
export const reconcileFileWatcher = ({
  repoRoot,
  provider,
}: {
  readonly repoRoot: string
  readonly provider?: 'watchman'
}): void => {
  const path = join(repoRoot, '.buckconfig.local')
  if (existsSync(path) === true && lstatSync(path).isSymbolicLink() === true)
    throw new Error('Buck file watcher: .buckconfig.local must not be a symbolic link')
  const current = existsSync(path) === true ? readFileSync(path, 'utf8') : ''
  const unmanaged = withoutManagedWatcherBlock(current)
  const block =
    provider === undefined
      ? ''
      : `${managedBegin}\n[buck2]\n  file_watcher = ${provider}\n${managedEnd}\n`
  const next =
    block === ''
      ? unmanaged === ''
        ? ''
        : `${unmanaged}\n`
      : unmanaged === ''
        ? block
        : `${unmanaged}\n\n${block}`
  if (next === current) return
  const candidate = `${path}.candidate-${randomUUID()}`
  try {
    writeFileSync(candidate, next, { flag: 'wx', mode: 0o600 })
    renameSync(candidate, path)
  } finally {
    rmSync(candidate, { force: true })
  }
}

/** A failed service/root admission never selects an incremental fallback provider. */
export class WatchmanAdmissionError extends Error {
  readonly reason: 'timeout' | 'executable' | 'service' | 'response' | 'root'

  constructor({
    reason,
    command,
    detail,
    fix,
  }: {
    readonly reason: WatchmanAdmissionError['reason']
    readonly command: string
    readonly detail: string
    readonly fix: string
  }) {
    super(
      `Buck2 Watchman watch-project probe failed (${reason}): ${detail}\nProbe: ${command}\nFix: ${fix}\nRefusing to use notify: its event buffer is not synchronized with completed source writes.`,
    )
    this.name = 'WatchmanAdmissionError'
    this.reason = reason
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Probe the actual service and root; a local version response proves neither. */
export const probeWatchman = async ({
  env,
  repoRoot,
  deadlineMs,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly repoRoot: string
  readonly deadlineMs: number
}): Promise<boolean> => {
  const root = realpathSync(repoRoot)
  const socket = env['WATCHMAN_SOCK']
  const args = [
    ...(process.platform === 'darwin' ? ['--no-spawn'] : []),
    '--no-local',
    ...(socket === undefined ? [] : [`--sockname=${socket}`]),
    '--output-encoding=json',
    'watch-project',
    root,
  ]
  const command = ['watchman', ...args].map(shellQuote).join(' ')
  const query = (): Promise<unknown> => {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    execFile(
      'watchman',
      args,
      { env, timeout: deadlineMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null) {
          const reason =
            error.killed === true ? 'timeout' : error.code === 'ENOENT' ? 'executable' : 'service'
          reject(
            new WatchmanAdmissionError({
              reason,
              command,
              detail:
                reason === 'timeout'
                  ? `service did not answer within ${deadlineMs} ms`
                  : stderr.trim() || error.message,
              fix:
                reason === 'executable'
                  ? 'enter the repository development environment (`devenv shell`) so Watchman is on PATH, then rerun the probe'
                  : socket === undefined
                    ? `restore the Watchman service, then run ${command}`
                    : `check WATCHMAN_SOCK=${shellQuote(socket)} selects the intended running service, then run ${command}`,
            }),
          )
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(
            new WatchmanAdmissionError({
              reason: 'response',
              command,
              detail: 'service returned invalid JSON',
              fix: `repair the Watchman executable/service on PATH, then run ${command}`,
            }),
          )
        }
      },
    )
    return promise
  }
  // A delayed process/socket response is retried once without a sleep or a new deadline knob.
  let response: unknown
  try {
    response = await query()
  } catch (error) {
    if (error instanceof WatchmanAdmissionError && error.reason === 'timeout')
      response = await query()
    else throw error
  }
  if (
    typeof response !== 'object' ||
    response === null ||
    'version' in response === false ||
    typeof response.version !== 'string' ||
    'watch' in response === false ||
    typeof response.watch !== 'string' ||
    'error' in response
  )
    throw new WatchmanAdmissionError({
      reason: 'response',
      command,
      detail:
        typeof response === 'object' && response !== null && 'error' in response
          ? String(response.error)
          : 'service response must contain a version and watched root',
      fix: `restore the Watchman service and its root permissions, then run ${command}`,
    })
  let watchedRoot: string
  try {
    watchedRoot = realpathSync(response.watch)
  } catch {
    throw new WatchmanAdmissionError({
      reason: 'root',
      command,
      detail: `watched root does not exist: ${response.watch}`,
      fix: `watchman watch ${shellQuote(root)}; then run ${command}`,
    })
  }
  if (watchedRoot !== root || ('relative_path' in response && response.relative_path !== ''))
    throw new WatchmanAdmissionError({
      reason: 'root',
      command,
      detail: `expected ${root}, but Watchman selected ${response.watch}; an ancestor may ignore source paths`,
      fix: `watchman watch ${shellQuote(root)}; then run ${command}`,
    })
  return true
}

/** Stop a legacy/provider-mismatched daemon only in this invocation's registered isolation. */
export const reconcileWatcherDaemon = ({
  native,
  repoRoot,
  args,
  env,
  provider,
}: {
  readonly native: string
  readonly repoRoot: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly provider: string
}): void => {
  let isolation = env['BUCK_ISOLATION_DIR'] ?? 'v2'
  for (let index = 0; index < args.length && args[index] !== '--'; index++) {
    const arg = args[index] ?? ''
    if (arg === '--isolation-dir') isolation = args[++index] ?? ''
    else if (arg.startsWith('--isolation-dir=') === true) isolation = arg.slice(16)
  }
  if (
    isolation === '' ||
    isolation === '.' ||
    isolation === '..' ||
    isolation.includes('/') === true
  )
    throw new Error('Buck2 watcher migration: isolation must be one nonempty directory component')
  const buckHome = join(env['HOME'] ?? homedir(), '.buck')
  const projectPath = repoRoot.replace(/^\//u, '')
  const daemonState = join(buckHome, 'buckd', projectPath, isolation)
  // Native startup deletes every daemon-dir entry except buckd.lifecycle.
  // Keep our marker and flock outside that directory so admission survives startup.
  const state = join(buckHome, 'file-watcher-admission-v1', projectPath)
  const marker = join(state, `${isolation}.json`)
  const admitted = (): boolean => {
    if (existsSync(marker) === false) return false
    if (lstatSync(marker).isFile() === false)
      throw new Error(`Buck2 watcher migration: invalid provider marker ${marker}`)
    const value: unknown = JSON.parse(readFileSync(marker, 'utf8'))
    return (
      typeof value === 'object' &&
      value !== null &&
      'schema' in value &&
      value.schema === 'effect-utils/buck2-file-watcher-admission/v1' &&
      'provider' in value &&
      value.provider === provider
    )
  }
  if (admitted() === true) return
  mkdirSync(state, { recursive: true, mode: 0o700 })
  if (lstatSync(state).isDirectory() === false)
    throw new Error(`Buck2 watcher migration: invalid isolation state ${state}`)
  if (process.platform !== 'linux' && process.platform !== 'darwin')
    throw new Error(`Buck2 watcher migration does not support ${process.platform}`)
  // Same crash-released BSD flock boundary as capability publication; no PID scraping or lock stealing.
  const lock = dlopen(process.platform === 'linux' ? 'libc.so.6' : '/usr/lib/libSystem.B.dylib', {
    flock: { args: ['i32', 'i32'], returns: 'i32' },
  })
  const descriptor = openSync(join(state, `${isolation}.lock`), 'a', 0o600)
  try {
    if (lock.symbols.flock(descriptor, 2) !== 0)
      throw new Error('Buck2 watcher migration flock failed')
    if (admitted() === true) return
    const pidPath = join(daemonState, 'buckd.pid')
    if (existsSync(pidPath) === true) {
      if (lstatSync(pidPath).isFile() === false)
        throw new Error(`Buck2 watcher migration: invalid registered daemon ${pidPath}`)
      process.stderr.write(
        `Buck2 watcher migration: stopping ${repoRoot} (${isolation}) before ${provider} startup\n`,
      )
      const result = spawnSync(native, ['--isolation-dir', isolation, 'kill'], {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        timeout: 30000,
      })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0)
        throw new Error(
          `Buck2 watcher migration: scoped daemon stop failed (${isolation}): ${result.stderr.trim()}`,
        )
    }
    const candidate = `${marker}.candidate-${randomUUID()}`
    try {
      writeFileSync(
        candidate,
        JSON.stringify({ schema: 'effect-utils/buck2-file-watcher-admission/v1', provider }),
        { flag: 'wx', mode: 0o600 },
      )
      renameSync(candidate, marker)
    } finally {
      rmSync(candidate, { force: true })
    }
  } finally {
    closeSync(descriptor)
    lock.close()
  }
}
