#!/usr/bin/env -S bun
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { connect, type ClientHttp2Stream } from 'node:http2'
import { BlockList, isIP } from 'node:net'
import { resolve } from 'node:path'
import process from 'node:process'

const MANAGED_BEGIN = '# effect-utils standalone cache posture: begin'
const MANAGED_END = '# effect-utils standalone cache posture: end'

/** Trusted digest-CAS endpoint and publication tier declared by tracked Buck config. */
export type TrustedArchiveOrigin = {
  readonly tier: 'private'
  readonly urlPrefix: string
}

/** Match Buck's UUID parser and emit the native lowercase hyphenated trace-ID spelling. */
export const canonicalCacheAdmissionInvocationId = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Invalid cache admission invocation ID')
  const plain =
    value.length === 45 && value.startsWith('urn:uuid:') === true
      ? value.slice(9)
      : value.length === 38 && value.startsWith('{') === true && value.endsWith('}') === true
        ? value.slice(1, -1)
        : value
  if (
    /^[a-f0-9]{32}$/i.test(plain) === false &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(plain) === false
  )
    throw new Error('Invalid cache admission invocation ID')
  const hex = plain.replaceAll('-', '').toLowerCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** Parse Buck section/key assignments, with later assignments taking precedence. */
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

const trustedCacheBlock = (origin: TrustedArchiveOrigin | undefined): string =>
  origin === undefined
    ? `${MANAGED_BEGIN}\n${MANAGED_END}`
    : `${MANAGED_BEGIN}
[archive_origin]
  url_prefix = ${origin.urlPrefix}
  tier = ${origin.tier}
${MANAGED_END}`

const privateWriterCacheBlock = ({
  env,
  trustedOrigin,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly trustedOrigin: TrustedArchiveOrigin | undefined
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
  http_headers = authorization: Basic $BUCK2_PRIVATE_CACHE_WRITE_BASIC_AUTH${
    trustedOrigin === undefined
      ? ''
      : `
[archive_origin]
  url_prefix = ${trustedOrigin.urlPrefix}
  tier = ${trustedOrigin.tier}`
  }
${MANAGED_END}`
}

const fail = (message: string): never => {
  throw new Error(`standalone Buck cache posture: ${message}`)
}

/** Remove only the launcher-owned overlay, rejecting malformed or duplicate managed blocks. */
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
  readonly trustedOrigin: TrustedArchiveOrigin | undefined
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
  const tracked = readFileSync(resolve(repoRoot, '.buckconfig'), 'utf8')
  const trustedOrigin =
    env['BUCK2_NO_REMOTE_CACHE'] === '1' ||
    env['BUCK2_PUBLIC_CACHE_READ_ONLY'] === '1' ||
    buckConfigValues(tracked)['archive_origin.trusted_url_prefix'] === undefined
      ? undefined
      : trustedArchiveOriginFromConfig(tracked)
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

/** Fixed categories, timings, and redacted socket facts are safe for public CI. */
export type RemoteCacheProbeFailure = {
  readonly errorClass:
    | 'configuration'
    | 'dns'
    | 'tcp'
    | 'tls'
    | 'transport'
    | 'deadline'
    | 'auth'
    | 'http'
    | 'grpc'
    | 'protocol'
  readonly phase: 'configuration' | 'dns' | 'tcp' | 'tls' | 'response'
  readonly elapsedMs: number
  readonly deadlineMs: number
}

/** Actual socket setup milestones with public-only addresses and monotonic timing. */
export type RemoteCacheProbeConnectionEvent = {
  readonly event: 'dns-resolved' | 'tcp-attempt' | 'tcp-connected' | 'tls-ready'
  readonly elapsedMs: number
  readonly address: string | undefined
  readonly family: 'IPv4' | 'IPv6' | undefined
}

const privateProbeIPv4 = new BlockList()
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const)
  privateProbeIPv4.addSubnet(address, prefix, 'ipv4')
const publicProbeIPv6 = new BlockList()
publicProbeIPv6.addSubnet('2000::', 3, 'ipv6')

/** Expose public IPs only; private, tailnet, local, mapped, and invalid addresses stay hidden. */
export const publicProbeAddress = (address: string): string => {
  const family = isIP(address)
  if (family === 4 && privateProbeIPv4.check(address, 'ipv4') === false) return address
  if (family === 6 && publicProbeIPv6.check(address, 'ipv6') === true) return address
  return 'redacted'
}

const probeErrorClass = (error: unknown): RemoteCacheProbeFailure['errorClass'] => {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns'
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ENETUNREACH' ||
    code === 'EHOSTUNREACH'
  )
    return 'tcp'
  if (code === 'ETIMEDOUT') return 'deadline'
  if (
    typeof code === 'string' &&
    (code.startsWith('ERR_TLS_') === true ||
      code.startsWith('ERR_SSL_') === true ||
      code === 'CERT_HAS_EXPIRED' ||
      code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'SELF_SIGNED_CERT_IN_CHAIN' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY')
  )
    return 'tls'
  return 'transport'
}

/** Require a successful bounded REAPI capabilities response using the selected client identity. */
export const probeRemoteCacheCapabilities = async ({
  address: cacheAddress,
  instanceName,
  tls,
  header,
  env,
  deadlineMs,
  onFailure,
  onConnectionEvent,
}: {
  readonly address: string | undefined
  readonly instanceName: string
  readonly tls: boolean
  readonly header: string | undefined
  readonly env: Readonly<Record<string, string | undefined>>
  readonly deadlineMs: number
  readonly onFailure?: (failure: RemoteCacheProbeFailure) => void
  readonly onConnectionEvent?: (event: RemoteCacheProbeConnectionEvent) => void
}): Promise<boolean> => {
  const started = performance.now()
  let phase: RemoteCacheProbeFailure['phase'] = 'configuration'
  const failProbe = (errorClass: RemoteCacheProbeFailure['errorClass']): false => {
    onFailure?.({
      errorClass,
      phase,
      elapsedMs: Math.round(performance.now() - started),
      deadlineMs,
    })
    return false
  }
  try {
    if (cacheAddress === undefined) return failProbe('configuration')
    const url = new URL(cacheAddress)
    if (url.protocol !== 'grpc:' && url.protocol !== 'grpcs:') return failProbe('configuration')
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
      if (colon === -1) return failProbe('configuration')
      const value = header
        .slice(colon + 1)
        .trim()
        .replace(/\$([A-Z_][A-Z0-9_]*)/gu, (_, key: string) => env[key] ?? '')
      headers[header.slice(0, colon).trim().toLowerCase()] = value
    }
    phase = isIP(url.hostname.replace(/^\[|\]$/gu, '')) === 0 ? 'dns' : 'tcp'
    return await new Promise<boolean>((resolveProbe) => {
      const client = connect(authority)
      let settled = false
      const socket = client.socket
      const connectionEvent = ({
        event,
        address,
        family,
      }: {
        readonly event: RemoteCacheProbeConnectionEvent['event']
        readonly address?: string
        readonly family?: number | string
      }) => {
        if (settled === true) return
        onConnectionEvent?.({
          event,
          elapsedMs: Math.round(performance.now() - started),
          address: address === undefined ? undefined : publicProbeAddress(address),
          family:
            family === 4 || family === 'IPv4'
              ? 'IPv4'
              : family === 6 || family === 'IPv6'
                ? 'IPv6'
                : undefined,
        })
      }
      // Observe the actual socket; do not pre-resolve or replace its lookup/selection policy.
      socket.on('lookup', (error: Error | null | undefined, address: string, family: number) => {
        if (error !== null && error !== undefined) return
        phase = 'tcp'
        connectionEvent({ event: 'dns-resolved', address, family })
      })
      socket.on('connectionAttempt', (address: string, _port: number, family: number) => {
        phase = 'tcp'
        connectionEvent({ event: 'tcp-attempt', address, family })
      })
      socket.on('connect', () => {
        if (settled === true) return
        phase = authority.startsWith('https:') === true ? 'tls' : 'response'
        connectionEvent({
          event: 'tcp-connected',
          address: socket.remoteAddress,
          family: socket.remoteFamily,
        })
      })
      socket.on('secureConnect', () => {
        if (settled === true) return
        phase = 'response'
        connectionEvent({
          event: 'tls-ready',
          address: socket.remoteAddress,
          family: socket.remoteFamily,
        })
      })
      const finish = ({
        result,
        errorClass = 'protocol',
      }: {
        readonly result: boolean
        readonly errorClass?: RemoteCacheProbeFailure['errorClass']
      }) => {
        if (settled === true) return
        settled = true
        clearTimeout(timer)
        client.destroy()
        if (result === false) failProbe(errorClass)
        resolveProbe(result)
      }
      const timer = setTimeout(() => finish({ result: false, errorClass: 'deadline' }), deadlineMs)
      client.on('connect', () => {
        phase = 'response'
      })
      client.on('error', (error) => finish({ result: false, errorClass: probeErrorClass(error) }))
      let stream: ClientHttp2Stream
      try {
        stream = client.request(headers)
      } catch (error) {
        finish({ result: false, errorClass: probeErrorClass(error) })
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
        if (size > 65536) return finish({ result: false })
        chunks.push(chunk)
      })
      stream.on('error', (error) => finish({ result: false, errorClass: probeErrorClass(error) }))
      stream.on('end', () => {
        const body = Buffer.concat(chunks)
        finish({
          result:
            httpStatus === 200 &&
            contentType?.startsWith('application/grpc') === true &&
            grpcStatus === '0' &&
            body.length >= 5 &&
            body[0] === 0 &&
            body.readUInt32BE(1) === body.length - 5,
          errorClass:
            httpStatus === 401 || httpStatus === 403 || grpcStatus === '7' || grpcStatus === '16'
              ? 'auth'
              : httpStatus !== 200
                ? 'http'
                : grpcStatus !== undefined && grpcStatus !== '0'
                  ? 'grpc'
                  : 'protocol',
        })
      })
      stream.end(frame)
    })
  } catch (error) {
    // Never put endpoint, credential, or transport error strings into CI logs.
    return failProbe(phase === 'configuration' ? 'configuration' : probeErrorClass(error))
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
