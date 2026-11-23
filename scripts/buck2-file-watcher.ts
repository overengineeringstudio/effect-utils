import { dlopen } from 'bun:ffi'
import { execFile, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  accessSync,
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
  writeSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { getPriority, homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

import { buckConfigValues, readConfig } from './buck2-cache-posture.ts'

const watcherMarkers = {
  admission: {
    begin: '# BEGIN effect-utils file watcher admission',
    end: '# END effect-utils file watcher admission',
  },
  profile: {
    begin: '# BEGIN effect-utils file watcher profile',
    end: '# END effect-utils file watcher profile',
  },
}

const withoutWatcherBlock = ({
  current,
  scope,
}: {
  readonly current: string
  readonly scope: keyof typeof watcherMarkers
}): string => {
  const { begin, end } = watcherMarkers[scope]
  const output: string[] = []
  let inside = false
  let found = false
  for (const line of current.split(/\r?\n/u)) {
    if (line === begin) {
      if (inside === true || found === true) throw new Error('duplicate managed file watcher block')
      inside = true
      found = true
    } else if (line === end) {
      if (inside === false) throw new Error('unmatched managed file watcher block end')
      inside = false
    } else if (inside === false) output.push(line)
  }
  if (inside === true) throw new Error('unterminated managed file watcher block')
  return output.join('\n').trimEnd()
}

/** Keep explicit local providers and the independently managed cache/profile overlays intact. */
export const withoutManagedWatcherBlock = (current: string): string =>
  withoutWatcherBlock({ current, scope: 'admission' })

type ReconcileFileWatcherOptions = { readonly repoRoot: string } & (
  | { readonly scope: 'profile'; readonly provider: 'watchman' | 'notify' }
  | { readonly scope?: 'admission'; readonly provider?: 'watchman' }
)

/** The initial native daemon reads its watcher from this file, not CLI overrides. */
export const reconcileFileWatcher = ({
  repoRoot,
  scope = 'admission',
  provider,
}: ReconcileFileWatcherOptions): void => {
  const path = join(repoRoot, '.buckconfig.local')
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true)
    throw new Error('Buck file watcher: .buckconfig.local must not be a symbolic link')
  const current = existsSync(path) === true ? readFileSync(path, 'utf8') : ''
  // Validate both owners, and retire the old admission selection before a profile write.
  withoutWatcherBlock({ current, scope: 'profile' })
  const admissionFree = withoutManagedWatcherBlock(current)
  const unmanaged = withoutWatcherBlock({
    current: scope === 'profile' ? admissionFree : current,
    scope,
  })
  const { begin, end } = watcherMarkers[scope]
  const block =
    provider === undefined ? '' : `${begin}\n[buck2]\n  file_watcher = ${provider}\n${end}\n`
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

/** Check both profile ownership and the actual persisted daemon-startup selection. */
export const assertProfileFileWatcher = ({
  repoRoot,
  provider,
}: {
  readonly repoRoot: string
  readonly provider: 'watchman' | 'notify'
}): void => {
  const path = join(repoRoot, '.buckconfig.local')
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() === true)
    throw new Error('Buck file watcher: .buckconfig.local must not be a symbolic link')
  const current = existsSync(path) === true ? readFileSync(path, 'utf8') : ''
  withoutManagedWatcherBlock(current)
  withoutWatcherBlock({ current, scope: 'profile' })
  const { begin, end } = watcherMarkers.profile
  const lines = current.split(/\r?\n/u)
  const start = lines.indexOf(begin)
  const block = start === -1 ? '' : lines.slice(start + 1, lines.indexOf(end, start)).join('\n')
  const effective = buckConfigValues(
    `${readConfig({ path: join(repoRoot, '.buckconfig') })}\n${readConfig({ path })}`,
  )['buck2.file_watcher']
  if (buckConfigValues(block)['buck2.file_watcher'] !== provider || effective !== provider)
    throw new Error(
      `Buck file watcher: expected profile-owned and effective buck2.file_watcher=${provider}; run python3 scripts/worktree-env.py prepare, then restart the affected root/isolation daemon if its provider changed`,
    )
}

/** A failed service/root admission never selects an incremental fallback provider. */
export class WatchmanAdmissionError extends Error {
  readonly reason:
    | 'timeout'
    | 'executable'
    | 'service'
    | 'priority'
    | 'response'
    | 'root'
    | 'socket'

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

/** Linux needs a trailing NUL in sun_path[108]; Darwin has sun_path[104]. */
export const assertWatchmanSocket = (socket: string): void => {
  const limit = process.platform === 'darwin' ? 103 : 107
  if (Buffer.byteLength(socket) <= limit && socket.includes('\0') === false) return
  throw new WatchmanAdmissionError({
    reason: 'socket',
    command: 'watchman --sockname=<socket> watch-project <root>',
    detail: `socket path must be at most ${limit} UTF-8 bytes without NUL (${Buffer.byteLength(socket)} bytes supplied)`,
    fix: 'select a shorter absolute WATCHMAN_SOCK, or unset it to use the checkout-owned managed location',
  })
}

/** One persistent service per checkout, isolated from other users and checkouts. */
export const prepareWatchmanEnvironment = ({
  env,
  repoRoot,
}: {
  readonly env: Record<string, string | undefined>
  readonly repoRoot: string
}): string | undefined => {
  if (env['WATCHMAN_SOCK'] !== undefined) {
    assertWatchmanSocket(env['WATCHMAN_SOCK'])
    return undefined
  }
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('Watchman managed state requires a Unix UID')
  const root = realpathSync(repoRoot)
  const directory = join(root, '.worktree-tools', 'watchman')
  // The service socket is always addressed through a short owned /tmp alias:
  // a socket inside the checkout breaks Nix source copying, which rejects
  // non-regular files regardless of filters. Watchman state stays
  // checkout-private under .worktree-tools/watchman.
  const alias = join('/tmp', `eu-wm-wt-${uid}-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`)
  const socket = join(alias, 'sock')
  try {
    mkdirSync(alias, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const aliasStat = lstatSync(alias)
  if (
    aliasStat.isDirectory() === false ||
    aliasStat.isSymbolicLink() === true ||
    aliasStat.uid !== uid ||
    (aliasStat.mode & 0o777) !== 0o700
  )
    throw new WatchmanAdmissionError({
      reason: 'socket',
      command: 'prepare Watchman address alias',
      detail: `${alias} must be a current-user-owned directory with mode 0700`,
      fix: `repair or remove the unsafe alias after stopping its Watchman service; no default-path fallback is permitted`,
    })
  try {
    mkdirSync(directory, { mode: 0o700 })
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
  }
  const owned = lstatSync(directory)
  if (
    owned.isDirectory() === false ||
    owned.isSymbolicLink() === true ||
    owned.uid !== uid ||
    (owned.mode & 0o777) !== 0o700
  )
    throw new WatchmanAdmissionError({
      reason: 'socket',
      command: 'prepare Watchman state',
      detail: `${directory} must be a current-user-owned directory with mode 0700`,
      fix: 'repair or remove the unsafe directory after stopping its Watchman service; no default-path fallback is permitted',
    })
  // Native Buck's Rust connector reads this directly; CLI probes need --sockname.
  env['WATCHMAN_SOCK'] = socket
  return directory
}

/** The real Watchman client exits silently when --no-spawn finds no reachable
 * service. A client-local get-sockname never spawns or connects, so an absent
 * reported socket is the evidence that no default service exists. */
const defaultServiceMissing = async ({
  env,
  deadlineMs,
  deadlineSignal,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly deadlineMs: number
  readonly deadlineSignal?: AbortSignal
}): Promise<boolean> => {
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      let closed: Promise<void> | undefined
      const child = execFile(
        'watchman',
        ['--no-spawn', '--output-encoding=json', 'get-sockname'],
        {
          env,
          timeout: deadlineSignal === undefined ? deadlineMs : undefined,
          signal: deadlineSignal,
          killSignal: 'SIGKILL',
          maxBuffer: 64 * 1024,
        },
        async (error, out) => {
          if (closed !== undefined) await closed
          if (error !== null) reject(error)
          else resolve(out)
        },
      )
      if (deadlineSignal !== undefined)
        closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()))
    })
    const parsed: unknown = JSON.parse(stdout)
    const sockname =
      typeof parsed === 'object' && parsed !== null && 'sockname' in parsed
        ? parsed.sockname
        : undefined
    if (typeof sockname !== 'string' || sockname === '') return false
    accessSync(sockname)
    return false
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
  }
}

/** A stale socket can outlive its server. Only connection refusal or absence
 * proves the managed service is stopped; permissions and other errors do not. */
const managedServiceMissing = ({
  socket,
  deadlineMs,
  deadlineSignal,
}: {
  readonly socket: string
  readonly deadlineMs: number
  readonly deadlineSignal?: AbortSignal
}): Promise<boolean> => {
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const connection = createConnection({ path: socket, signal: deadlineSignal })
  const finish = (missing: boolean) => {
    connection.destroy()
    resolve(missing)
  }
  connection.once('connect', () => finish(false))
  connection.once('error', (error: NodeJS.ErrnoException) =>
    finish(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'),
  )
  connection.setTimeout(deadlineMs, () => finish(false))
  return promise
}

/** Probe the actual service and root; a local version response proves neither. */
export const probeWatchman = async ({
  env,
  repoRoot,
  deadlineMs,
  makeDeadlineSignal,
  managedDirectory,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly repoRoot: string
  readonly deadlineMs: number
  readonly makeDeadlineSignal?: () => AbortSignal | undefined
  readonly managedDirectory?: string
}): Promise<boolean> => {
  const root = realpathSync(repoRoot)
  const socket = env['WATCHMAN_SOCK']
  if (socket !== undefined) assertWatchmanSocket(socket)
  const niceValue = getPriority()
  // A gate may use a running service, but must not create a permanently niced shared one.
  const nicedDefault = (socket === undefined || managedDirectory !== undefined) && niceValue > 0
  const args = [
    ...(nicedDefault === true || (socket !== undefined && managedDirectory === undefined)
      ? ['--no-spawn']
      : []),
    '--no-local',
    ...(socket === undefined ? [] : [`--sockname=${socket}`]),
    ...(managedDirectory === undefined
      ? []
      : [
          '--no-site-spawner',
          '--no-save-state',
          `--pidfile=${join(managedDirectory, 'pid')}`,
          `--logfile=${join(managedDirectory, 'log')}`,
        ]),
    '--output-encoding=json',
    'watch-project',
    root,
  ]
  const command = ['watchman', ...args].map(shellQuote).join(' ')
  const query = (): Promise<unknown> => {
    const deadlineSignal = makeDeadlineSignal?.()
    let closed: Promise<void> | undefined
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const child = execFile(
      'watchman',
      args,
      {
        env,
        timeout: deadlineSignal === undefined ? deadlineMs : undefined,
        signal: deadlineSignal,
        killSignal: 'SIGKILL',
        maxBuffer: 64 * 1024,
      },
      async (error, stdout, stderr) => {
        // AbortSignal reports its error before process close. Do not retry or
        // remove fixtures until the actual child and its output pipes are reaped.
        if (closed !== undefined) await closed
        if (error !== null) {
          const priorityRefusal = stderr.match(
            /nice_value=(\d+), min_acceptable_nice_value=\d+[\s\S]*Watchman is refusing to start/,
          )
          // Priority is diagnosed only from evidence: Watchman's own startup
          // refusal, or a niced --no-spawn probe whose silent failure is
          // proven to mean "no service". A leftover managed socket proves
          // nothing; connect without spawning to distinguish it from a live listener.
          let reason: 'timeout' | 'executable' | 'priority' | 'service' = 'service'
          if (error.killed === true || deadlineSignal?.aborted === true) reason = 'timeout'
          else if (error.code === 'ENOENT' || error.code === 'EACCES') reason = 'executable'
          else if (priorityRefusal !== null) reason = 'priority'
          else if (
            nicedDefault === true &&
            stdout.trim() === '' &&
            stderr.trim() === '' &&
            (managedDirectory !== undefined
              ? socket !== undefined &&
                (await managedServiceMissing({
                  socket,
                  deadlineMs,
                  deadlineSignal: makeDeadlineSignal?.(),
                }))
              : (await defaultServiceMissing({
                  env,
                  deadlineMs,
                  deadlineSignal: makeDeadlineSignal?.(),
                })) === true) === true
          )
            reason = 'priority'
          reject(
            new WatchmanAdmissionError({
              reason,
              command,
              detail:
                reason === 'timeout'
                  ? `service did not answer within ${deadlineMs} ms`
                  : reason === 'priority'
                    ? priorityRefusal !== null
                      ? `Watchman refuses to start at nice ${priorityRefusal[1] ?? niceValue}; this client may only connect to an already-running service. ${stderr.trim() || error.message}`
                      : `no ${managedDirectory === undefined ? 'default' : 'managed'} Watchman service is running and this client at nice ${niceValue} will not spawn one; ${error.message}`
                    : stderr.trim() || error.message,
              fix:
                reason === 'executable'
                  ? 'enter the repository development environment (`devenv shell`) so a runnable Watchman is on PATH, then rerun the probe'
                  : reason === 'priority'
                    ? managedDirectory === undefined
                      ? 'start the service un-niced (`watchman get-sockname` outside the gate) or provision the host service, then rerun the probe; do not relax the shared service priority limit'
                      : `outside the gate, start the exact managed service un-niced: ${['watchman', ...args.filter((arg) => arg !== '--no-spawn')].map(shellQuote).join(' ')}; do not relax the shared service priority limit`
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
    if (deadlineSignal !== undefined)
      closed = new Promise<void>((resolveClosed) => child.once('close', () => resolveClosed()))
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

/** Root creation/reuse is a crawl operation, not a short service liveness probe. */
export class WatchmanCrawlError extends Error {
  readonly reason = 'crawl'

  constructor({
    root,
    deadlineMs,
    cause,
  }: {
    readonly root: string
    readonly deadlineMs: number
    readonly cause: unknown
  }) {
    super(
      `Buck2 Watchman initial crawl failed (crawl): ${root}; initialization budget ${deadlineMs} ms.\n${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    )
    this.name = 'WatchmanCrawlError'
  }
}

/** Register an owned root before checks enter their short admission critical path. */
export const initializeWatchmanRoot = async ({
  env,
  repoRoot,
  deadlineMs,
  managedDirectory,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly repoRoot: string
  readonly deadlineMs: number
  readonly managedDirectory?: string
}): Promise<void> => {
  const root = realpathSync(repoRoot)
  const started = performance.now()
  const deadline = AbortSignal.timeout(deadlineMs)
  let outcome = 'error'
  writeSync(
    2,
    `${JSON.stringify({ event: 'buck2.watchman.crawl', phase: 'start', root, deadlineMs })}\n`,
  )
  try {
    await probeWatchman({
      env,
      repoRoot: root,
      deadlineMs,
      managedDirectory,
      // The existing timeout retry shares one total crawl deadline. A timed-out
      // first attempt cannot acquire a second initialization budget.
      makeDeadlineSignal: () => deadline,
    })
    outcome = 'ok'
  } catch (cause) {
    throw new WatchmanCrawlError({ root, deadlineMs, cause })
  } finally {
    writeSync(
      2,
      `${JSON.stringify({ event: 'buck2.watchman.crawl', phase: 'end', root, durationMs: performance.now() - started, outcome })}\n`,
    )
  }
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
      value.schema === 'effect-utils/buck2-file-watcher-admission/v2' &&
      'provider' in value &&
      value.provider === provider &&
      'socket' in value &&
      value.socket === (env['WATCHMAN_SOCK'] ?? null)
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
      writeSync(
        2,
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
        JSON.stringify({
          schema: 'effect-utils/buck2-file-watcher-admission/v2',
          provider,
          socket: env['WATCHMAN_SOCK'] ?? null,
        }),
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
