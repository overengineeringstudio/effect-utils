#!/usr/bin/env -S bun
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type ClientHttp2Stream } from 'node:http2'
import { resolve } from 'node:path'
import process from 'node:process'

const MANAGED_BEGIN = '# effect-utils standalone cache posture: begin'
const MANAGED_END = '# effect-utils standalone cache posture: end'

/** Trusted digest-CAS endpoint and publication tier declared by tracked Buck config. */
export type TrustedArchiveOrigin = {
  readonly tier: 'private'
  readonly urlPrefix: string
}

export const buckConfigValues = (text: string): Record<string, string> => {
  let section = ''
  const values: Record<string, string> = {}
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*$/u, '').trim()
    if (line === '') continue
    const sectionMatch = /^\[([^\]]+)\]$/u.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1] ?? ''
      continue
    }
    const equals = line.indexOf('=')
    if (equals !== -1)
      values[`${section}.${line.slice(0, equals).trim()}`] = line.slice(equals + 1).trim()
  }
  return values
}

/** Parse the reviewed trusted archive destination from tracked Buck config. */
export const trustedArchiveOriginFromConfig = (text: string): TrustedArchiveOrigin => {
  const values = buckConfigValues(text)
  const urlPrefix = values['archive_origin.trusted_url_prefix']
  const tier = values['archive_origin.trusted_tier']
  if (urlPrefix === undefined || /^https?:\/\/.+\/cas\/$/u.test(urlPrefix) === false)
    return fail('tracked trusted archive origin must be an http(s) URL ending with /cas/')
  if (tier !== 'private') return fail('tracked trusted archive tier must be private')
  return { tier, urlPrefix }
}

/** Public CI reads anonymously; tracked REAPI addresses and TLS remain in force. */
const PUBLIC_READ_CACHE_BLOCK = `${MANAGED_BEGIN}
[buck2]
  remote_cache_enabled = true
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
${MANAGED_END}`

/** Explicit escape hatch for cache outages, including public CI. */
const NO_REMOTE_CACHE_BLOCK = `${MANAGED_BEGIN}
[buck2]
  remote_cache_enabled = false
  allow_cache_uploads = false
[archive_origin]
  url_prefix =
  tier = public
${MANAGED_END}`

/**
 * Protected public-tier publisher. The tracked cache tier is read-only; a job that
 * holds the writer credential enables uploads and the Basic header. Buck expands
 * the header variable in the daemon, so the credential value never enters any
 * config file. Publishers run off the tailnet, so archives come from the public
 * registry rather than the private trusted origin.
 */
const PUBLISHER_CACHE_BLOCK = `${MANAGED_BEGIN}
[buck2]
  allow_cache_uploads = true
  default_allow_cache_upload = true
[buck2_re_client]
  http_headers = authorization: Basic $BUCK2_CACHE_WRITE_BASIC_AUTH
[archive_origin]
  url_prefix =
  tier = public
${MANAGED_END}`

const trustedCacheBlock = ({ tier, urlPrefix }: TrustedArchiveOrigin): string => `${MANAGED_BEGIN}
[archive_origin]
  url_prefix = ${urlPrefix}
  tier = ${tier}
${MANAGED_END}`

const privateWriterCacheBlock = ({
  env,
  trustedOrigin,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly trustedOrigin: TrustedArchiveOrigin
}): string => {
  const address = env['BUCK2_PRIVATE_CACHE_ADDRESS']
  if (address === undefined || /^grpc:\/\/[^/\s]+$/u.test(address) === false)
    return fail('private writer requires a declared grpc:// BUCK2_PRIVATE_CACHE_ADDRESS')
  return `${MANAGED_BEGIN}
[buck2]
  remote_cache_enabled = true
  allow_cache_uploads = true
[buck2_re_client]
  action_cache_address = ${address}
  cas_address = ${address}
  engine_address = ${address}
  tls = false
  http_headers = authorization: Basic $BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH
[archive_origin]
  url_prefix = ${trustedOrigin.urlPrefix}
  tier = ${trustedOrigin.tier}
${MANAGED_END}`
}

const fail = (message: string): never => {
  throw new Error(`standalone Buck cache posture: ${message}`)
}

export const withoutManagedBlock = (
  current: string,
): { readonly content: string; readonly found: boolean } => {
  const output: string[] = []
  let inside = false
  let found = false
  for (const line of current.split(/\r?\n/u)) {
    if (line === MANAGED_BEGIN) {
      if (inside === true || found === true) fail('duplicate managed block in .buckconfig.local')
      inside = true
      found = true
      continue
    }
    if (line === MANAGED_END) {
      if (inside === false) fail('unmatched managed block end in .buckconfig.local')
      inside = false
      continue
    }
    if (inside === false) output.push(line)
  }
  if (inside === true) fail('unterminated managed block in .buckconfig.local')
  return { content: output.join('\n').trimEnd(), found }
}

/**
 * Derive the standalone checkout's local Buck config. The exact no-remote
 * escape hatch wins over both public reads and a present writer credential.
 */
export const standaloneCachePostureConfig = ({
  current,
  env,
  trustedOrigin,
}: {
  readonly current: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly trustedOrigin: TrustedArchiveOrigin
}): string => {
  const withoutManaged = withoutManagedBlock(current)
  const managed =
    env['BUCK2_NO_REMOTE_CACHE'] === '1'
      ? NO_REMOTE_CACHE_BLOCK
      : env['BUCK2_PUBLIC_CACHE_READ_ONLY'] === '1'
        ? PUBLIC_READ_CACHE_BLOCK
        : (env['BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH'] ?? '') !== ''
          ? privateWriterCacheBlock({ env, trustedOrigin })
          : (env['BUCK2_CACHE_WRITE_BASIC_AUTH'] ?? '') !== ''
            ? PUBLISHER_CACHE_BLOCK
            : trustedCacheBlock(trustedOrigin)
  const unmanaged = withoutManaged.content
  return unmanaged === '' ? `${managed}\n` : `${unmanaged}\n\n${managed}\n`
}

/** Atomically publish or remove only the managed cache posture block. */
export const reconcileStandaloneCachePosture = ({
  repoRoot,
  env,
}: {
  readonly repoRoot: string
  readonly env: Readonly<Record<string, string | undefined>>
}): void => {
  const output = resolve(repoRoot, '.buckconfig.local')
  const exists = existsSync(output)
  if (exists === true && lstatSync(output).isSymbolicLink() === true)
    fail('.buckconfig.local must not be a symbolic link')
  const current = exists === true ? readFileSync(output, 'utf8') : ''
  const trustedOrigin = trustedArchiveOriginFromConfig(
    readFileSync(resolve(repoRoot, '.buckconfig'), 'utf8'),
  )
  const next = standaloneCachePostureConfig({ current, env, trustedOrigin })
  if (next === current) return
  const candidate = `${output}.candidate-${randomUUID().replaceAll('-', '')}`
  try {
    writeFileSync(candidate, next, { flag: 'wx', mode: 0o600 })
    renameSync(candidate, output)
  } finally {
    rmSync(candidate, { force: true })
  }
}

/**
 * Any HTTP response proves the origin answers (a bare prefix request is not a valid CAS key, so a
 * 4xx is expected); only DNS, connection, or deadline failures count as unreachable.
 */
export const probeArchiveOrigin = async ({
  urlPrefix,
  deadlineMs,
}: {
  readonly urlPrefix: string
  readonly deadlineMs: number
}): Promise<boolean> => {
  try {
    await fetch(urlPrefix, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(deadlineMs),
    })
    return true
  } catch {
    return false
  }
}

export const probeRemoteCacheCapabilities = async ({
  address,
  instanceName,
  tls,
  header,
  env,
  deadlineMs,
}: {
  readonly address: string | undefined
  readonly instanceName: string
  readonly tls: boolean
  readonly header: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly deadlineMs: number
}): Promise<boolean> => {
  try {
    if (address === undefined) return false
    const url = new URL(address)
    if (url.protocol !== 'grpc:' && url.protocol !== 'grpcs:') return false
    const authority = `${tls === true || url.protocol === 'grpcs:' ? 'https' : 'http'}://${url.host}`
    const name = Buffer.from(instanceName)
    const length: number[] = []
    let remaining = name.length
    do {
      const octet = remaining % 128
      remaining = Math.floor(remaining / 128)
      length.push(octet | (remaining > 0 ? 0x80 : 0))
    } while (remaining > 0)
    const frame = Buffer.allocUnsafe(name.length + length.length + 6)
    frame[0] = 0
    frame.writeUInt32BE(frame.length - 5, 1)
    frame[5] = 0x0a
    frame.set(length, 6)
    name.copy(frame, 6 + length.length)

    const headers: Record<string, string> = {
      ':method': 'POST',
      ':path': '/build.bazel.remote.execution.v2.Capabilities/GetCapabilities',
      'content-type': 'application/grpc',
      te: 'trailers',
      'grpc-timeout': `${deadlineMs}m`,
    }
    if (header !== undefined) {
      const colon = header.indexOf(':')
      if (colon === -1) return false
      const value = header
        .slice(colon + 1)
        .trim()
        .replace(/\$([A-Z_][A-Z0-9_]*)/gu, (_, key: string) => env[key] ?? '')
      headers[header.slice(0, colon).trim().toLowerCase()] = value
    }
    return await new Promise<boolean>((resolveProbe) => {
      const client = connect(authority)
      let settled = false
      const finish = (result: boolean) => {
        if (settled === true) return
        settled = true
        clearTimeout(timer)
        client.destroy()
        resolveProbe(result)
      }
      const timer = setTimeout(() => finish(false), deadlineMs)
      client.on('error', () => finish(false))
      let stream: ClientHttp2Stream
      try {
        stream = client.request(headers)
      } catch {
        finish(false)
        return
      }
      let httpStatus: number | undefined
      let contentType: string | undefined
      let grpcStatus: string | undefined
      const chunks: Buffer[] = []
      let size = 0
      stream.on('response', (response) => {
        httpStatus = response[':status']
        contentType = String(response['content-type'] ?? '')
        if (response['grpc-status'] !== undefined) grpcStatus = String(response['grpc-status'])
      })
      stream.on('trailers', (trailers) => {
        grpcStatus = String(trailers['grpc-status'] ?? '')
      })
      stream.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 65536) return finish(false)
        chunks.push(chunk)
      })
      stream.on('error', () => finish(false))
      stream.on('end', () => {
        const body = Buffer.concat(chunks)
        finish(
          httpStatus === 200 &&
            contentType?.startsWith('application/grpc') === true &&
            grpcStatus === '0' &&
            body.length >= 5 &&
            body[0] === 0 &&
            body.readUInt32BE(1) === body.length - 5,
        )
      })
      stream.end(frame)
    })
  } catch {
    // Never put endpoint, credential, or transport error strings into CI logs.
    return false
  }
}

if (import.meta.main === true)
  try {
    const repoRoot = process.argv[2] ?? fail('expected repository root argument')
    reconcileStandaloneCachePosture({ repoRoot, env: process.env })
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
