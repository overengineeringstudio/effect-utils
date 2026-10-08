#!/usr/bin/env -S bun
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
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import type { CacheAdmissionInvocation } from '../genie/ci-scripts/buck2-cache-evidence.ts'
import {
  buckConfigValues,
  canonicalCacheAdmissionInvocationId,
  probeArchiveOrigin,
  probeRemoteCacheCapabilities,
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
  trustedArchiveOriginFromConfig,
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
  process.stderr.write(`warning: Buck2 ${message}\n`)
  if (env['GITHUB_ACTIONS'] === 'true')
    process.stderr.write(`::warning title=Buck2 cache::${message}\n`)
}

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
}: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cacheDirectory?: string
  readonly deadlineMs?: number
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
      probe: () => probeWatchman({ env, repoRoot: root, deadlineMs }),
    })
    // Never admit a negative cached outcome, including entries written by an older launcher.
    if (available === false) await probeWatchman({ env, repoRoot: root, deadlineMs })
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
    trackedValues['archive_origin.trusted_url_prefix'] === undefined &&
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
  // Fixed-source builds use Buck's native no-cache flag. Resolve cache selection
  // before parsing archive trust metadata that cache-less sandboxes never use.
  const cacheDisabled =
    env['BUCK2_NO_REMOTE_CACHE'] === '1' ||
    configArgs.includes('--no-remote-cache') === true ||
    (cliValues['buck2.remote_cache_enabled'] ?? base['buck2.remote_cache_enabled']) === 'false'
  const postureEnv = cacheDisabled === true ? { ...env, BUCK2_NO_REMOTE_CACHE: '1' } : env
  const trustedOrigin =
    cacheDisabled === true ||
    env['BUCK2_PUBLIC_CACHE_READ_ONLY'] === '1' ||
    trackedValues['archive_origin.trusted_url_prefix'] === undefined
      ? undefined
      : trustedArchiveOriginFromConfig(tracked)
  const posture = standaloneCachePostureConfig({ current: '', env: postureEnv, trustedOrigin })
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
        trustedOrigin,
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
  const prefix = values['archive_origin.url_prefix'] ?? ''
  const admission: CacheAdmissionInvocation = {
    invocationId: canonicalCacheAdmissionInvocationId(env['BUCK_WRAPPER_UUID'] ?? randomUUID()),
    admissionFallbacks: { reapi: 0, archiveOrigin: 0 },
    admissionRetrySuccesses: { reapi: 0, archiveOrigin: 0 },
  }
  // Two sequential, independently bounded attempts: at most 5000 ms per endpoint.
  // The endpoints run concurrently; no backoff extends the admission budget.
  const retryProbe = async ({
    endpoint,
    probe,
  }: {
    readonly endpoint: 'reapi' | 'archiveOrigin'
    readonly probe: () => Promise<boolean>
  }): Promise<boolean> => {
    if ((await probe()) === true) return true
    const available = await probe()
    if (available === true) admission.admissionRetrySuccesses[endpoint] = 1
    return available
  }
  const [remoteAvailable, archiveAvailable] = await Promise.all([
    remote === false
      ? true
      : cachedProbe({
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
                  onFailure: ({ errorClass, phase, elapsedMs, deadlineMs: probeDeadlineMs }) =>
                    process.stderr.write(
                      `warning: Buck2 REAPI probe failed: class=${errorClass} phase=${phase} elapsed_ms=${elapsedMs} deadline_ms=${probeDeadlineMs}\n`,
                    ),
                  onConnectionEvent: ({ event, elapsedMs, address, family }) =>
                    process.stderr.write(
                      `Buck2 REAPI probe: event=${event} elapsed_ms=${elapsedMs} address=${address ?? 'unavailable'} family=${family ?? 'unavailable'}\n`,
                    ),
                }),
            }),
        }),
    prefix === ''
      ? true
      : cachedProbe({
          cacheDirectory,
          key: JSON.stringify(['archive', prefix]),
          probe: () =>
            retryProbe({
              endpoint: 'archiveOrigin',
              probe: () => probeArchiveOrigin({ urlPrefix: prefix, deadlineMs }),
            }),
        }),
  ])
  admission.admissionFallbacks.reapi = remoteAvailable === false ? 1 : 0
  admission.admissionFallbacks.archiveOrigin = archiveAvailable === false ? 1 : 0
  const evidencePath = env['CI_BUCK2_CACHE_EVIDENCE_PATH']
  if (evidencePath !== undefined && evidencePath !== '') {
    try {
      mkdirSync(dirname(evidencePath), { recursive: true })
      appendFileSync(`${evidencePath}.admission.jsonl`, `${JSON.stringify(admission)}\n`, {
        mode: 0o600,
      })
    } catch {
      process.stderr.write('warning: Buck2 admission evidence could not be persisted\n')
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
  if (archiveAvailable === false) {
    warning({
      message: 'archive origin is unreachable; fetching archives from the registry',
      env,
    })
    Object.assign(overrides, { 'archive_origin.url_prefix': '', 'archive_origin.tier': 'public' })
  }
  const extra = Object.entries(overrides).flatMap(([key, value]) => ['--config', `${key}=${value}`])
  const before = sentinel === -1 ? [...args] : args.slice(0, sentinel)
  const admitted =
    remoteAvailable === false || archiveAvailable === false
      ? before.filter((arg) => arg !== '--reuse-current-config')
      : before
  return [...admitted, ...extra, ...(sentinel === -1 ? [] : args.slice(sentinel))]
}

if (import.meta.main === true) {
  try {
    const native = process.argv[2]
    if (native === undefined) throw new Error('expected pinned Buck binary')
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
    process.execve(native, [native, ...args], process.env)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
