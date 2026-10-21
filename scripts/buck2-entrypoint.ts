#!/usr/bin/env -S bun
import { cc, dlopen } from 'bun:ffi'
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { CacheAdmissionInvocation } from '../genie/ci-scripts/buck2-cache-evidence.ts'
import {
  buckConfigValues,
  canonicalCacheAdmissionInvocationId,
  probeRemoteCacheCapabilities,
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
  withoutManagedBlock,
} from './buck2-cache-posture.ts'
import {
  probeWatchman,
  reconcileFileWatcher,
  reconcileWatcherDaemon,
  withoutManagedWatcherBlock,
} from './buck2-file-watcher.ts'

const configCommands: Record<string, true> = {
  build: true,
  test: true,
  run: true,
  install: true,
  audit: true,
  cquery: true,
  uquery: true,
  aquery: true,
  targets: true,
  bxl: true,
}
const readOptional = (path: string): string =>
  existsSync(path) === true ? readFileSync(path, 'utf8') : ''

const readConfig = ({
  path,
  seen = new Set<string>(),
}: {
  readonly path: string
  readonly seen?: Set<string>
}): string => {
  const absolute = resolve(path)
  if (seen.has(absolute) === true) throw new Error('Buck cache posture: recursive config include')
  seen.add(absolute)
  const text = readOptional(absolute).replace(/^\s*<file:([^>]+)>\s*$/gmu, (_, include: string) =>
    readConfig({ path: resolve(dirname(absolute), include), seen }),
  )
  seen.delete(absolute)
  return text
}

const findRoot = (cwd: string): string | undefined => {
  let root = resolve(cwd)
  while (true) {
    if (existsSync(join(root, '.buckroot')) === true) return root
    const parent = dirname(root)
    if (parent === root) return undefined
    root = parent
  }
}

const skipsWatcherAdmission = (args: readonly string[]): boolean => {
  if (args.some((arg) => ['--help', '-h', '--version'].includes(arg)) === true) return true
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (
      [
        '--isolation-dir',
        '--verbose',
        '-v',
        '--oncall',
        '--client-metadata',
        '--setting',
        '--agent-context',
      ].includes(arg) === true
    ) {
      index++
      continue
    }
    if (arg.startsWith('-') === true) continue
    return ['kill', 'status', 'log'].includes(arg)
  }
  return true
}

let admissionExpires = Date.now() + 5000
let failedOpen = false

/** A short-lived endpoint result, not a cached config or authorization decision. */
const cachedProbe = async ({
  key,
  cacheDirectory,
  probe,
  now = Date.now(),
  root,
}: {
  readonly key: string
  readonly cacheDirectory: string
  readonly probe: () => Promise<boolean>
  readonly now?: number
  readonly root?: string
}): Promise<boolean> => {
  // Root-keyed watcher admission can be reclaimed without knowing the original
  // environment/config variants. Endpoint admission remains shared across roots.
  const prefix = root === undefined ? '' : `${createHash('sha256').update(root).digest('hex')}-`
  const path = join(
    cacheDirectory,
    `${prefix}${createHash('sha256').update(key).digest('hex')}.json`,
  )
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (
      typeof value === 'object' &&
      value !== null &&
      'at' in value &&
      'available' in value &&
      typeof value.at === 'number' &&
      typeof value.available === 'boolean' &&
      now >= value.at &&
      now - value.at < 5000
    ) {
      admissionExpires = Math.min(admissionExpires, value.at + 5000)
      return value.available
    }
  } catch {
    /* Missing or stale cache entries are probed again. */
  }
  const available = await probe()
  const candidate = `${path}.${randomUUID()}`
  try {
    mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 })
    writeFileSync(candidate, JSON.stringify({ at: now, available }), { flag: 'wx', mode: 0o600 })
    renameSync(candidate, path)
  } catch {
    /* Cache storage is an optimization, never a build prerequisite. */
  } finally {
    try {
      rmSync(candidate, { force: true })
    } catch {
      /* An inaccessible cache directory must not turn cleanup into a build failure. */
    }
  }
  return available
}

const warning = ({
  message,
  env,
}: {
  readonly message: string
  readonly env: Readonly<Record<string, string | undefined>>
}): void => {
  failedOpen = true
  writeSync(2, `warning: Buck2 ${message}\n`)
  if (env['GITHUB_ACTIONS'] === 'true') writeSync(2, `::warning title=Buck2 cache::${message}\n`)
}

/** Admission probe whose deadline a test can control through `probeDeadlineSignal`. */
export type AdmissionProbeEndpoint = 'watchman' | 'reapi'

/** Admit the initial file watcher and cache posture before pinned native startup. */
export const directBuckArguments = async ({
  args,
  cwd,
  env,
  cacheDirectory = join(
    env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
    'effect-utils',
    'buck2-posture-v2',
  ),
  deadlineMs = 2500,
  probeDeadlineSignal,
}: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cacheDirectory?: string
  readonly deadlineMs?: number
  /** Supply a fresh caller-controlled deadline for each probe; undefined uses the platform timer. */
  readonly probeDeadlineSignal?: (endpoint: AdmissionProbeEndpoint) => AbortSignal | undefined
}): Promise<string[]> => {
  admissionExpires = Date.now() + 5000
  failedOpen = false
  const sentinel = args.indexOf('--')
  const configArgs = sentinel === -1 ? args : args.slice(0, sentinel)
  const command = configArgs.find((arg) => configCommands[arg] === true)
  if (skipsWatcherAdmission(configArgs) === true) return [...args]
  const root = findRoot(cwd)
  if (root === undefined) return [...args]
  const tracked = readConfig({ path: join(root, '.buckconfig') })
  const trackedValues = buckConfigValues(tracked)
  const currentLocal = readConfig({ path: join(root, '.buckconfig.local') })
  const localWithoutWatcher = withoutManagedWatcherBlock(currentLocal)
  const explicitWatcher = buckConfigValues(localWithoutWatcher)['buck2.file_watcher']
  const selectedWatcher = explicitWatcher ?? trackedValues['buck2.file_watcher']
  if (selectedWatcher === 'watchman') {
    const watchmanProbe = () =>
      probeWatchman({
        env,
        repoRoot: root,
        deadlineMs,
        makeDeadlineSignal:
          probeDeadlineSignal === undefined ? undefined : () => probeDeadlineSignal('watchman'),
      })
    const available = await cachedProbe({
      cacheDirectory,
      root: realpathSync(root),
      key: JSON.stringify([
        'watchman-root-admission-v1',
        realpathSync(root),
        readOptional(join(root, '.watchmanconfig')),
        process.platform,
        env['PATH'],
        env['HOME'],
        env['XDG_RUNTIME_DIR'],
        env['WATCHMAN_SOCK'],
        env['WATCHMAN_STATE_DIR'],
        env['TMPDIR'],
        env['TMP'],
        env['USER'],
        env['LOGNAME'],
        env['WATCHMAN_CONFIG_FILE'],
      ]),
      probe: watchmanProbe,
    })
    // Never admit a negative cached outcome, including entries written by an older launcher.
    if (available === false) await watchmanProbe()
    reconcileFileWatcher({
      repoRoot: root,
      provider: explicitWatcher === undefined ? 'watchman' : undefined,
    })
  } else if (localWithoutWatcher !== currentLocal.trimEnd()) {
    reconcileFileWatcher({ repoRoot: root })
  }
  // Watcher startup is independent of the narrower cache-command allowlist.
  if (command === undefined) return [...args]
  const unmanaged = withoutManagedBlock(localWithoutWatcher)
  const local = unmanaged.content
  const base = buckConfigValues(`${tracked}\n${local}`)
  // Unrelated Buck projects do not opt into effect-utils' cache policy.
  if (
    base['buck2_re_client.action_cache_address'] === undefined &&
    base['buck2.remote_cache_enabled'] !== 'true'
  )
    return [...args]
  const cliValues: Record<string, string> = {}
  for (let index = 0; index < configArgs.length; index++) {
    const arg = configArgs[index] ?? ''
    const value =
      arg === '-c' || arg === '--config'
        ? configArgs[++index]
        : arg.startsWith('--config=') === true
          ? arg.slice(9)
          : arg.startsWith('-c') === true && arg.length > 2
            ? arg.slice(2)
            : undefined
    if (value !== undefined) {
      const equals = value.indexOf('=')
      if (equals !== -1 && value.startsWith('buck2_re_client.') === false)
        cliValues[value.slice(0, equals)] = value.slice(equals + 1)
    }
    if (arg === '--config-file' || arg.startsWith('--config-file=') === true) {
      const path = arg === '--config-file' ? configArgs[++index] : arg.slice(14)
      if (path !== undefined)
        for (const [key, configValue] of Object.entries(
          buckConfigValues(readConfig({ path: resolve(cwd, path) })),
        ))
          if (key.startsWith('buck2_re_client.') === false) cliValues[key] = configValue
    }
  }
  // Fixed-source builds use Buck's native no-cache flag.
  const cacheDisabled =
    env['BUCK2_NO_REMOTE_CACHE'] === '1' ||
    configArgs.includes('--no-remote-cache') === true ||
    (cliValues['buck2.remote_cache_enabled'] ?? base['buck2.remote_cache_enabled']) === 'false'
  const postureEnv = cacheDisabled === true ? { ...env, BUCK2_NO_REMOTE_CACHE: '1' } : env
  const posture = standaloneCachePostureConfig({ current: '', env: postureEnv })
  // Native RE client construction ignores CLI config. Writer headers/endpoints must
  // be in the root overlay before daemon startup, including removal on public reads.
  if (
    unmanaged.found === true ||
    Object.keys(buckConfigValues(posture)).some((key) => key.startsWith('buck2_re_client.')) ===
      true
  )
    reconcileStandaloneCachePosture({ repoRoot: root, env: postureEnv })
  const overrides = buckConfigValues(posture)
  const values = { ...base, ...overrides, ...cliValues }
  for (const key of Object.keys(overrides)) overrides[key] = values[key] ?? ''
  if (cacheDisabled === true || env['BUCK2_PUBLIC_CACHE_READ_ONLY'] === '1') {
    const disabled = buckConfigValues(
      standaloneCachePostureConfig({
        current: '',
        env: postureEnv,
      }),
    )
    Object.assign(values, disabled)
    Object.assign(overrides, disabled)
  }
  const header = (values['buck2_re_client.http_headers'] ?? '').replace(
    /\$([A-Z_][A-Z0-9_]*)/gu,
    (_, key: string) => env[key] ?? '',
  )
  const remote = (values['buck2.remote_cache_enabled'] ?? 'true') === 'true'
  const admission: CacheAdmissionInvocation = {
    invocationId: canonicalCacheAdmissionInvocationId(env['BUCK_WRAPPER_UUID'] ?? randomUUID()),
    admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
    admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
  }
  // Two sequential, independently bounded attempts: at most 5000 ms.
  const retryProbe = async ({
    endpoint,
    probe,
  }: {
    readonly endpoint: 'reapi'
    readonly probe: () => Promise<boolean>
  }): Promise<boolean> => {
    if ((await probe()) === true) return true
    const available = await probe()
    if (available === true) admission.admissionRetrySuccesses[endpoint] = 1
    return available
  }
  const remoteAvailable =
    remote === false
      ? true
      : await cachedProbe({
          cacheDirectory,
          key: JSON.stringify([
            'reapi',
            values['buck2_re_client.action_cache_address'],
            values['buck2_re_client.instance_name'],
            values['buck2_re_client.tls'],
            header,
          ]),
          probe: () =>
            retryProbe({
              endpoint: 'reapi',
              probe: () =>
                probeRemoteCacheCapabilities({
                  address: values['buck2_re_client.action_cache_address'],
                  instanceName: values['buck2_re_client.instance_name'] ?? '',
                  tls: values['buck2_re_client.tls'] !== 'false',
                  header: values['buck2_re_client.http_headers'],
                  env,
                  deadlineMs,
                  deadlineSignal: probeDeadlineSignal?.('reapi'),
                  onFailure: ({ errorClass, phase, elapsedMs, deadlineMs: probeDeadlineMs }) =>
                    writeSync(
                      2,
                      `warning: Buck2 REAPI probe failed: class=${errorClass} phase=${phase} elapsed_ms=${elapsedMs} deadline_ms=${probeDeadlineMs}\n`,
                    ),
                  onConnectionEvent: ({ event, elapsedMs, address, family }) =>
                    writeSync(
                      2,
                      `Buck2 REAPI probe: event=${event} elapsed_ms=${elapsedMs} address=${address ?? 'unavailable'} family=${family ?? 'unavailable'}\n`,
                    ),
                }),
            }),
        })
  admission.admissionFallbacks.reapi = remoteAvailable === false ? 1 : 0
  const evidencePath = env['CI_BUCK2_CACHE_EVIDENCE_PATH']
  if (evidencePath !== undefined && evidencePath !== '') {
    try {
      mkdirSync(dirname(evidencePath), { recursive: true })
      appendFileSync(`${evidencePath}.admission.jsonl`, `${JSON.stringify(admission)}\n`, {
        mode: 0o600,
      })
    } catch {
      writeSync(2, 'warning: Buck2 admission evidence could not be persisted\n')
    }
  }
  if (remoteAvailable === false) {
    if (values['buck2.allow_cache_uploads'] === 'true' && env['BUCK2_CACHE_WRITE_OPTIONAL'] !== '1')
      throw new Error(
        'Buck cache writer: REAPI unreachable; refusing to publish without remote cache',
      )
    warning({
      message: 'REAPI is unreachable; using local execution without the remote cache',
      env,
    })
    Object.assign(overrides, {
      'buck2.remote_cache_enabled': 'false',
      'buck2.allow_cache_uploads': 'false',
    })
  }
  const extra = Object.entries(overrides).flatMap(([key, value]) => ['--config', `${key}=${value}`])
  const before = sentinel === -1 ? [...args] : args.slice(0, sentinel)
  const admitted =
    remoteAvailable === false ? before.filter((arg) => arg !== '--reuse-current-config') : before
  return [...admitted, ...extra, ...(sentinel === -1 ? [] : args.slice(sentinel))]
}

/** Unknown status never grants permission to interrupt a shared daemon. */
export const gateDaemonStopDecision = ({
  status,
  root,
  isolation,
}: {
  readonly status: unknown
  readonly root: string
  readonly isolation: string
}): 'stop' | 'keep-active' | 'keep-unrecognized' => {
  if (
    typeof status !== 'object' ||
    status === null ||
    'project_root' in status === false ||
    status.project_root !== root ||
    'isolation_dir' in status === false ||
    status.isolation_dir !== isolation ||
    'active_commands' in status === false ||
    Array.isArray(status.active_commands) === false
  )
    return 'keep-unrecognized'
  return status.active_commands.length === 0 ? 'stop' : 'keep-active'
}

/** Compare gate ownership, not action/resource-control child cgroups. */
export const gateScopeIdentity = (membership: string): string | undefined => {
  const path = membership
    .split('\n')
    .find((line) => line.startsWith('0::'))
    ?.slice(3)
  if (path?.startsWith('/') !== true) return undefined
  const components = path.split('/')
  const scope = components.findLastIndex(
    (component) => component.startsWith('gate-slot-') && component.endsWith('.scope'),
  )
  return scope === -1 ? undefined : components.slice(0, scope + 1).join('/')
}

/** Retain unknown ownership; compare determinable unified gate scope owners. */
export const gateCgroupRelation = ({
  caller,
  daemon,
}: {
  readonly caller: string
  readonly daemon: string
}): 'same' | 'foreign' | 'unknown' => {
  const callerScope = gateScopeIdentity(caller)
  if (
    callerScope === undefined ||
    daemon.split('\n').some((line) => line.startsWith('0::/')) === false
  )
    return 'unknown'
  // A valid unified path outside any gate scope is determinably foreign.
  return gateScopeIdentity(daemon) === callerScope ? 'same' : 'foreign'
}

/**
 * Pin be6971d4 expands argfiles before clap (buck2_client_ctx/src/argfiles.rs).
 * Lines are arguments, not shell words; nested paths remain relative to the
 * invocation cwd. Config only participates in cell-path/fallback resolution,
 * not the isolation default (buck2/src/lib.rs: BeforeSubcommandOptions).
 *
 * Do not execute Python argfiles or consume stdin a second time, and do not
 * approximate Buck's config-backed cell resolver. Those forms retain daemons.
 *
 * RunCommand alone uses trailing_var_arg: a positional executable argument can
 * start its payload before `--`. Accept only `run TARGET [-- ...]`, with Buck
 * options before `run`; retain ambiguous run forms rather than model clap.
 * Test, install and bxl use raw payload arguments separated by `--`.
 */
export const resolveGateInvocation = ({
  args,
  env,
  cwd,
  readArgfile = (path) => {
    const canonical = realpathSync(path)
    return {
      path: canonical,
      contents: new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(canonical)),
    }
  },
}: {
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  readonly readArgfile?: (path: string) => { readonly path: string; readonly contents: string }
}): { readonly isolation: string; readonly args: readonly string[] } | undefined => {
  const expanded: string[] = []
  const active = new Set<string>()
  const expand = ({
    input,
    depth,
  }: {
    readonly input: readonly string[]
    readonly depth: number
  }): boolean => {
    if (depth > 64) return false
    for (let index = 0; index < input.length; index++) {
      const arg = input[index] ?? ''
      if (arg.includes('\0') === true) return false
      if (arg === '--') {
        expanded.push(...input.slice(index))
        break
      }
      if (arg.startsWith('--#') === true) continue
      if (arg.startsWith('--flagfile=') === true) return false
      if (arg !== '--flagfile' && arg.startsWith('@') === false) {
        expanded.push(arg)
        continue
      }
      const requested = arg === '--flagfile' ? input[++index] : arg.slice(1)
      if (
        requested === undefined ||
        requested === '' ||
        requested === '-' ||
        requested.includes('//') === true ||
        requested.includes('#') === true ||
        (requested.startsWith('/') === true && resolve(requested) !== requested)
      )
        return false
      // Missing cwd-relative files may use Buck's config-backed cell fallback.
      // A failed read therefore cannot be interpreted as an empty argfile.
      const file = readArgfile(resolve(cwd, requested))
      if (file.path.endsWith('.py') === true || active.has(file.path) === true) return false
      active.add(file.path)
      const lines = file.contents.split('\n').map((line) => line.replace(/\r$/u, ''))
      if (
        expand({
          input: lines.filter((line) => line !== ''),
          depth: depth + 1,
        }) === false
      )
        return false
      active.delete(file.path)
    }
    return true
  }
  try {
    if (expand({ input: args, depth: 0 }) === false) return undefined
  } catch {
    return undefined
  }
  const sentinel = expanded.indexOf('--')
  const buckArgs = sentinel === -1 ? expanded : expanded.slice(0, sentinel)
  const runIndex = buckArgs.indexOf('run')
  if (
    runIndex !== -1 &&
    (buckArgs.length !== runIndex + 2 || buckArgs[runIndex + 1]?.startsWith('-') !== false)
  )
    return undefined
  let isolation = env['BUCK_ISOLATION_DIR'] ?? 'v2'
  let explicit = false
  for (let index = 0; index < buckArgs.length; index++) {
    const arg = buckArgs[index] ?? ''
    if (arg === '--isolation-dir' || arg.startsWith('--isolation-dir=') === true) {
      // clap's scalar Set option rejects duplicate occurrences. Never guess
      // which one would win, including occurrences introduced by nested files.
      if (explicit === true) return undefined
      explicit = true
      isolation = arg === '--isolation-dir' ? (buckArgs[++index] ?? '') : arg.slice(16)
    } else if (arg.includes('--isolation') === true) return undefined
  }
  // Conservative subset of native FileNameBuf validation, including its
  // reserved output prefix. Unsupported names are retained, never normalized.
  return /^[A-Za-z0-9._-]+$/u.test(isolation) === true &&
    isolation !== '.' &&
    isolation !== '..' &&
    isolation.startsWith('._buck2') === false
    ? { isolation, args: buckArgs }
    : undefined
}

/** Native status is ExistingOnly: admission and cleanup never spawn a daemon. */
export const reconcileGateDaemon = ({
  native,
  root,
  args,
  env,
  phase,
}: {
  readonly native: string
  readonly root: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly phase: 'start' | 'exit'
}): void => {
  const invocation = resolveGateInvocation({ args, env, cwd: process.cwd() })
  if (invocation === undefined) {
    if (phase === 'start')
      writeSync(
        2,
        'warning: Buck2 gate retained daemon: native isolation could not be determined safely\n',
      )
    return
  }
  if (skipsWatcherAdmission(invocation.args) === true) return
  const { isolation } = invocation
  const globalArgs = ['--isolation-dir', isolation]
  const options = { cwd: root, env, encoding: 'utf8' as const, timeout: 30000 }
  const warn = (reason: string): void => {
    writeSync(2, `warning: Buck2 gate ${phase} retained ${isolation}: ${reason}\n`)
  }
  const result = spawnSync(native, [...globalArgs, 'status'], options)
  if (result.error !== undefined || result.status !== 0) {
    warn('native status unavailable')
    return
  }
  if (result.stdout.trim() === '') return
  let status: unknown
  try {
    status = JSON.parse(result.stdout)
  } catch {
    warn('native status is not JSON')
    return
  }
  const decision = gateDaemonStopDecision({ status, root: realpathSync(root), isolation })
  if (decision === 'keep-unrecognized') {
    warn('unrecognized daemon status')
    return
  }
  if (phase === 'start') {
    if (process.platform !== 'linux') return
    if (
      typeof status !== 'object' ||
      status === null ||
      'process_info' in status === false ||
      typeof status.process_info !== 'object' ||
      status.process_info === null ||
      'pid' in status.process_info === false ||
      typeof status.process_info.pid !== 'number' ||
      Number.isSafeInteger(status.process_info.pid) === false ||
      status.process_info.pid <= 0
    ) {
      warn('unrecognized daemon PID')
      return
    }
    let foreign: string
    try {
      foreign = readFileSync(`/proc/${status.process_info.pid}/cgroup`, 'utf8').trim()
      const caller = readFileSync('/proc/self/cgroup', 'utf8').trim()
      const relation = gateCgroupRelation({ caller, daemon: foreign })
      if (relation === 'same') return
      if (relation === 'unknown') {
        warn('gate scope ownership unavailable; daemon retained without migration')
        return
      }
    } catch (error) {
      // A daemon that exited between status and procfs needs no migration.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return
      warn('daemon cgroup unavailable')
      return
    }
    if (decision === 'keep-active') {
      writeSync(
        2,
        `warning: Buck2 gate accounting: reusing active daemon in foreign cgroup ${foreign.replaceAll('\n', '; ')}\n`,
      )
      return
    }
  } else if (decision === 'keep-active') return
  // Buck has no conditional kill RPC. A client arriving after this idle status
  // read can still race the kill; never kill a daemon already observed as busy.
  const stopped = spawnSync(native, [...globalArgs, 'kill'], options)
  if (stopped.error !== undefined || stopped.status !== 0) {
    if (phase === 'start') throw new Error('Buck2 gate admission: foreign idle daemon stop failed')
    warn('native kill failed')
  }
}

// Replaced by the Nix build; source execution uses TinyCC on the physical file.
declare const BUCK2_STDIO_LIBRARY: string
if (import.meta.main === true) {
  try {
    let restoreStdio: (() => void) | undefined
    try {
      const symbols = {
        eu_getfl: { args: ['i32'], returns: 'i32' },
        eu_setfl: { args: ['i32', 'i32'], returns: 'i32' },
      } as const
      // Packaged launches only load a prebuilt library. Source launches compile
      // a physical, header-free source file without generated packages or SDKs.
      const stdio =
        typeof BUCK2_STDIO_LIBRARY === 'string'
          ? dlopen(BUCK2_STDIO_LIBRARY, symbols)
          : cc({ source: new URL('./buck2-stdio.c', import.meta.url), symbols })
      const flags = [0, 1, 2].map((fd) => stdio.symbols.eu_getfl(fd))
      restoreStdio = () => {
        try {
          for (const [fd, value] of flags.entries()) {
            // Closed inherited descriptors have no status flags.
            if (
              value >= 0 &&
              (stdio.symbols.eu_setfl(fd, value) !== 0 || stdio.symbols.eu_getfl(fd) !== value)
            )
              throw new Error(`could not restore inherited fd ${fd} status flags`)
          }
        } finally {
          stdio.close()
        }
      }
    } catch (error) {
      writeSync(2, `warning: Buck2 stdio flag protection unavailable: ${String(error)}\n`)
    }
    const native = process.argv[2]
    if (native === undefined) throw new Error('expected pinned Buck binary')
    if (process.argv[3] === '--gate-cleanup' || process.argv[3] === '--gate-admit') {
      const root = findRoot(process.cwd())
      if (root !== undefined)
        reconcileGateDaemon({
          native,
          root,
          args: process.argv.slice(4),
          env: process.env,
          phase: process.argv[3] === '--gate-admit' ? 'start' : 'exit',
        })
      process.exit(0)
    }
    const auth = process.env['BUCK2_PRIVATE_CACHE_WRITE_AUTH']
    if (
      auth !== undefined &&
      auth !== '' &&
      process.env['BUCK2_PUBLIC_CACHE_READ_ONLY'] !== '1' &&
      process.env['BUCK2_NO_REMOTE_CACHE'] !== '1'
    ) {
      const colon = auth.indexOf(':')
      if (colon <= 0 || colon === auth.length - 1 || auth.startsWith('publisher:') === true)
        throw new Error('private cache writer requires a per-host username:password credential')
      process.env['BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH'] = Buffer.from(auth).toString('base64')
    }
    delete process.env['BUCK2_PRIVATE_CACHE_WRITE_AUTH']
    // Native Buck reads this UUID as its trace/build ID. Preserve OTEL's command identity.
    process.env['BUCK_WRAPPER_UUID'] ??= randomUUID()
    const launchCache = process.argv[3] === '--launch-cache' ? process.argv[4] : undefined
    const args = await directBuckArguments({
      args: process.argv.slice(launchCache === undefined ? 3 : 5),
      cwd: process.cwd(),
      env: process.env,
    })
    const sentinel = args.indexOf('--')
    const configArgs = sentinel === -1 ? args : args.slice(0, sentinel)
    const root = findRoot(process.cwd())
    if (root !== undefined && skipsWatcherAdmission(configArgs) === false) {
      const tracked = buckConfigValues(readConfig({ path: join(root, '.buckconfig') }))
      const local = buckConfigValues(readConfig({ path: join(root, '.buckconfig.local') }))
      const provider = local['buck2.file_watcher'] ?? tracked['buck2.file_watcher']
      if (
        provider !== undefined &&
        (provider === 'watchman' || tracked['buck2.file_watcher'] === 'watchman')
      )
        reconcileWatcherDaemon({
          native,
          repoRoot: root,
          args: configArgs,
          env: process.env,
          provider,
        })
    }
    if (launchCache !== undefined && launchCache !== '' && failedOpen === false) {
      const candidate = `${launchCache}.${randomUUID()}`
      try {
        mkdirSync(dirname(launchCache), { recursive: true, mode: 0o700 })
        writeFileSync(candidate, `${Math.floor(admissionExpires / 1000)}\n${args.join('\0')}\0`, {
          flag: 'wx',
          mode: 0o600,
        })
        renameSync(candidate, launchCache)
      } catch {
        /* Warm launch caching is optional. */
      } finally {
        try {
          rmSync(candidate, { force: true })
        } catch {
          /* An inaccessible cache directory must not turn cleanup into a build failure. */
        }
      }
    }
    if (process.execve === undefined)
      throw new Error('pinned Buck launcher requires a runtime with process.execve')
    // Synchronous diagnostics are the primary fix. Native flag restoration is
    // defence in depth and must not prevent Buck from running.
    try {
      restoreStdio?.()
    } catch (error) {
      writeSync(2, `warning: Buck2 stdio flag restoration failed: ${String(error)}\n`)
    }
    process.execve(native, [native, ...args], process.env)
  } catch (error) {
    writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
