import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { rename, unlink } from 'node:fs/promises'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { publicArchiveRedirectUrl, publicArchiveUrl } from './public-archive-origin.ts'

const fail = (message: string): never => {
  throw new Error(`pnpm archive acquisition: ${message}`)
}

export const archiveOriginFallbackReasons = [
  'not-found',
  'headers-timeout',
  'connection-error',
  'server-error',
] as const
export type ArchiveOriginFallbackReason = (typeof archiveOriginFallbackReasons)[number]
export type ArchiveOriginFallback = {
  readonly type: 'archive-origin-fallback'
  readonly reason: ArchiveOriginFallbackReason
  readonly sha256: string
  readonly status?: number
  readonly cleanupDiagnostic?: 'body-cancel-rejected'
}

/** Acquire verified bytes from CAS, reporting availability misses before registry recovery. */
export const acquireArchive = async ({
  casUrl,
  fetchArchive = fetch,
  headersTimeoutMs = 15_000,
  output,
  reportFallback = (fallback) => process.stderr.write(`${JSON.stringify(fallback)}\n`),
  registryUrl,
  sha256,
  size,
  transferTimeoutMs = 120_000,
}: {
  readonly casUrl: string
  readonly fetchArchive?: typeof fetch
  readonly headersTimeoutMs?: number
  readonly output: string
  readonly registryUrl: string
  readonly reportFallback?: (fallback: ArchiveOriginFallback) => void
  readonly sha256: string
  readonly size: number
  readonly transferTimeoutMs?: number
}): Promise<'cas' | 'registry'> => {
  if (/^[a-f0-9]{64}$/.test(sha256) === false) fail(`invalid sha256: ${sha256}`)
  if (Number.isSafeInteger(size) === false || size <= 0) fail(`invalid size: ${size}`)
  if (/^https?:\/\//.test(casUrl) === false) fail(`invalid CAS URL: ${casUrl}`)
  publicArchiveUrl({ url: registryUrl, location: 'archive URL' })

  const deadline = AbortSignal.timeout(transferTimeoutMs)
  const headersTimeoutError = new Error('pnpm archive acquisition: response headers timed out')
  const casController = new AbortController()
  let cleanupDiagnostic: ArchiveOriginFallback['cleanupDiagnostic']
  const cancelCasBody = async (response: Response | undefined): Promise<void> => {
    await response?.body?.cancel().catch(() => {
      // An errored/reset stream is already unusable; cleanup must not veto recovery.
      cleanupDiagnostic = 'body-cancel-rejected'
    })
  }
  const request = async (url: string, headers = new AbortController()): Promise<Response> => {
    const signal = AbortSignal.any([deadline, headers.signal])
    const timeout = setTimeout(() => headers.abort(headersTimeoutError), headersTimeoutMs)
    try {
      const response = await fetchArchive(url, { redirect: 'manual', signal })
      if (signal.aborted) {
        if (headers === casController) await cancelCasBody(response)
        else await response.body?.cancel()
        throw signal.reason
      }
      return response
    } catch (error) {
      if (headers.signal.aborted) throw headers.signal.reason
      headers.abort(error)
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  let cas: Response | undefined
  let reason: ArchiveOriginFallbackReason | undefined
  try {
    cas = await request(casUrl, casController)
  } catch (error) {
    if (deadline.aborted) throw error
    reason = error === headersTimeoutError ? 'headers-timeout' : 'connection-error'
  }
  if (cas !== undefined) {
    if (cas.status >= 300 && cas.status < 400) {
      await cas.body?.cancel()
      fail(`CAS redirect is not allowed: HTTP ${cas.status}`)
    }
    if (cas.status === 404) reason = 'not-found'
    else if (cas.status >= 500 && cas.status <= 599) reason = 'server-error'
  }
  const source = reason === undefined ? 'cas' : 'registry'
  let response = cas
  if (reason !== undefined) {
    casController.abort()
    await cancelCasBody(cas)
    reportFallback({
      type: 'archive-origin-fallback',
      reason,
      sha256,
      ...(cas === undefined ? {} : { status: cas.status }),
      ...(cleanupDiagnostic === undefined ? {} : { cleanupDiagnostic }),
    })
    let current = registryUrl
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      publicArchiveUrl({ url: current, location: 'archive download URL' })
      response = await request(current)
      if ([301, 302, 303, 307, 308].includes(response.status) === false) break
      const next = publicArchiveRedirectUrl({
        from: current,
        redirect: response.headers.get('location'),
      })
      await response.body?.cancel()
      current = next
      if (redirects === 3) fail(`archive download exceeded 3 redirects for ${registryUrl}`)
    }
  }
  if (response === undefined) fail('CAS returned no response')
  if (response.ok === false) fail(`${source} returned HTTP ${response.status}`)
  if (response.body === null) fail(`${source} returned no archive body`)

  const candidate = `${output}.candidate-${randomUUID()}`
  const hash = createHash('sha256')
  let received = 0
  const verifier = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.byteLength
      if (received > size) {
        callback(new Error(`pnpm archive acquisition: archive size exceeded ${size} bytes`))
        return
      }
      hash.update(chunk)
      callback(undefined, chunk)
    },
  })
  try {
    await pipeline(Readable.fromWeb(response.body), verifier, createWriteStream(candidate), {
      signal: deadline,
    })
    const actual = hash.digest('hex')
    if (actual !== sha256) fail(`archive digest mismatch: expected ${sha256}, got ${actual}`)
    if (received !== size) fail(`archive size mismatch: expected ${size}, got ${received}`)
    await rename(candidate, output)
  } catch (error) {
    await unlink(candidate).catch(() => undefined)
    throw error
  }
  return source
}

if (import.meta.main) {
  const args = new Map<string, string>()
  for (let index = 2; index < process.argv.length; index += 2) {
    const flag = process.argv[index]
    const value = process.argv[index + 1]
    if (flag === undefined || value === undefined || flag.startsWith('--') === false)
      fail('expected --flag value arguments')
    args.set(flag, value)
  }
  await acquireArchive({
    casUrl: args.get('--cas-url') ?? fail('--cas-url is required'),
    registryUrl: args.get('--registry-url') ?? fail('--registry-url is required'),
    sha256: args.get('--sha256') ?? fail('--sha256 is required'),
    size: Number(args.get('--size') ?? fail('--size is required')),
    output: args.get('--output') ?? fail('--output is required'),
  })
}
