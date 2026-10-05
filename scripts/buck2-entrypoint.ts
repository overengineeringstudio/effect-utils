#!/usr/bin/env -S bun
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'

import {
  buckConfigValues,
  probeArchiveOrigin,
  probeRemoteCacheCapabilities,
  reconcileStandaloneCachePosture,
  standaloneCachePostureConfig,
  trustedArchiveOriginFromConfig,
  withoutManagedBlock,
} from './buck2-cache-posture.ts'

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

const readConfig = (path: string, seen = new Set<string>()): string => {
  const absolute = resolve(path)
  if (seen.has(absolute) === true) throw new Error('Buck cache posture: recursive config include')
  seen.add(absolute)
  const text = readOptional(absolute).replace(/^\s*<file:([^>]+)>\s*$/gmu, (_, include: string) =>
    readConfig(resolve(dirname(absolute), include), seen),
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

let admissionExpires = Date.now() + 5000
let failedOpen = false

/** A short-lived endpoint result, not a cached config or authorization decision. */
const cachedProbe = async ({
  key,
  cacheDirectory,
  probe,
  now = Date.now(),
}: {
  readonly key: string
  readonly cacheDirectory: string
  readonly probe: () => Promise<boolean>
  readonly now?: number
}): Promise<boolean> => {
  const path = join(cacheDirectory, `${createHash('sha256').update(key).digest('hex')}.json`)
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
    rmSync(candidate, { force: true })
  }
  return available
}

const warning = (message: string, env: Readonly<Record<string, string | undefined>>): void => {
  failedOpen = true
  process.stderr.write(`warning: Buck2 ${message}\n`)
  if (env['GITHUB_ACTIONS'] === 'true')
    process.stderr.write(`::warning title=Buck2 cache::${message}\n`)
}

/** Apply cache posture at the pinned entrypoint; outage overrides are invocation-local. */
export const directBuckArguments = async ({
  args,
  cwd,
  env,
  cacheDirectory = join(
    env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
    'effect-utils',
    'buck2-posture-v1',
  ),
  deadlineMs = 900,
}: {
  readonly args: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cacheDirectory?: string
  readonly deadlineMs?: number
}): Promise<string[]> => {
  admissionExpires = Date.now() + 5000
  failedOpen = false
  const command = args.find((arg) => configCommands[arg] === true)
  if (command === undefined) return [...args]
  if (args.includes('--help') === true || args.includes('-h') === true) return [...args]
  const root = findRoot(cwd)
  if (root === undefined) return [...args]
  const tracked = readConfig(join(root, '.buckconfig'))
  const trackedValues = buckConfigValues(tracked)
  const currentLocal = readConfig(join(root, '.buckconfig.local'))
  const unmanaged = withoutManagedBlock(currentLocal)
  const local = unmanaged.content
  const base = buckConfigValues(`${tracked}\n${local}`)
  // Unrelated Buck projects do not opt into effect-utils' cache policy.
  if (
    trackedValues['archive_origin.trusted_url_prefix'] === undefined &&
    base['buck2.remote_cache_enabled'] !== 'true'
  )
    return [...args]
  const posture =
    trackedValues['archive_origin.trusted_url_prefix'] === undefined
      ? ''
      : standaloneCachePostureConfig({
          current: '',
          env,
          trustedOrigin: trustedArchiveOriginFromConfig(tracked),
        })
  // Native RE client construction ignores CLI config. Writer headers/endpoints must
  // be in the root overlay before daemon startup, including removal on public reads.
  if (
    (unmanaged.found === true ||
      Object.keys(buckConfigValues(posture)).some((key) => key.startsWith('buck2_re_client.'))) &&
    trackedValues['archive_origin.trusted_url_prefix'] !== undefined
  )
    reconcileStandaloneCachePosture({ repoRoot: root, env })
  const values = { ...base, ...buckConfigValues(posture) }
  const overrides = buckConfigValues(posture)
  const sentinel = args.indexOf('--')
  const configArgs = sentinel === -1 ? args : args.slice(0, sentinel)
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
        values[value.slice(0, equals)] = value.slice(equals + 1)
    }
    if (arg === '--config-file' || arg.startsWith('--config-file=') === true) {
      const path = arg === '--config-file' ? configArgs[++index] : arg.slice(14)
      if (path !== undefined)
        for (const [key, value] of Object.entries(buckConfigValues(readConfig(resolve(cwd, path)))))
          if (key.startsWith('buck2_re_client.') === false) values[key] = value
    }
  }
  for (const key of Object.keys(overrides)) overrides[key] = values[key] ?? ''
  if (env['BUCK2_NO_REMOTE_CACHE'] === '1' || env['BUCK2_PUBLIC_CACHE_READ_ONLY'] === '1') {
    const disabled = buckConfigValues(
      standaloneCachePostureConfig({
        current: '',
        env,
        trustedOrigin: { tier: 'private', urlPrefix: '' },
      }),
    )
    Object.assign(values, disabled)
    Object.assign(overrides, disabled)
  }
  const header = (values['buck2_re_client.http_headers'] ?? '').replace(
    /\$([A-Z_][A-Z0-9_]*)/gu,
    (_, key: string) => env[key] ?? '',
  )
  const remote = values['buck2.remote_cache_enabled'] === 'true'
  const prefix = values['archive_origin.url_prefix'] ?? ''
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
            probeRemoteCacheCapabilities({
              address: values['buck2_re_client.action_cache_address'],
              instanceName: values['buck2_re_client.instance_name'] ?? '',
              tls: values['buck2_re_client.tls'] !== 'false',
              header: values['buck2_re_client.http_headers'],
              env,
              deadlineMs,
            }),
        }),
    prefix === ''
      ? true
      : cachedProbe({
          cacheDirectory,
          key: JSON.stringify(['archive', prefix]),
          probe: () => probeArchiveOrigin({ urlPrefix: prefix, deadlineMs }),
        }),
  ])
  if (remoteAvailable === false) {
    if (values['buck2.allow_cache_uploads'] === 'true')
      throw new Error(
        'Buck cache writer: REAPI unreachable; refusing to publish without remote cache',
      )
    warning('REAPI is unreachable; using local execution without the remote cache', env)
    Object.assign(overrides, {
      'buck2.remote_cache_enabled': 'false',
      'buck2.allow_cache_uploads': 'false',
    })
  }
  if (archiveAvailable === false) {
    warning('archive origin is unreachable; fetching archives from the registry', env)
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
    const launchCache = process.argv[3] === '--launch-cache' ? process.argv[4] : undefined
    const args = await directBuckArguments({
      args: process.argv.slice(launchCache === undefined ? 3 : 5),
      cwd: process.cwd(),
      env: process.env,
    })
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
        rmSync(candidate, { force: true })
      }
    }
    process.execve(native, [native, ...args], process.env)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
