import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  decodePnpmSha256Sidecar,
  translatePnpmLock,
  validatePnpmSha256Sidecar,
  type PnpmSha256Entry,
} from './pnpm-lock.ts'

/** Effective archive destination after environment and Buck config precedence. */
export type ArchiveOrigin = {
  readonly tier: 'public' | 'private'
  readonly urlPrefix: string
}

type ArchiveSeedResult = 'present' | 'uploaded'

const fail = (message: string): never => {
  throw new Error(`pnpm archive seeder: ${message}`)
}

const sha = ({
  algorithm,
  bytes,
}: {
  readonly algorithm: 'sha256' | 'sha512'
  readonly bytes: Uint8Array
}): string =>
  createHash(algorithm)
    .update(bytes)
    .digest(algorithm === 'sha512' ? 'base64' : 'hex')

/** Reject archives whose classification is not publishable to the selected tier. */
export const assertArchiveAllowedForTier = ({
  archive,
  packageIdentity,
  tier,
}: {
  archive: PnpmSha256Entry
  packageIdentity: string
  tier: 'public' | 'private'
}): void => {
  if (tier === 'public' && archive.classification !== 'public')
    return fail(`private archive ${packageIdentity} cannot enter the public tier`)
}

/** Verify all recorded digest and size bindings for one archive. */
export const verifyArchive = ({
  archive,
  bytes,
  packageIdentity,
}: {
  archive: PnpmSha256Entry
  bytes: Uint8Array
  packageIdentity: string
}): void => {
  const integrity = `sha512-${sha({ algorithm: 'sha512', bytes })}`
  const digest = sha({ algorithm: 'sha256', bytes })
  if (integrity !== archive.integrity) return fail(`lock SHA-512 mismatch for ${packageIdentity}`)
  if (digest !== archive.sha256) return fail(`SHA-256 mismatch for ${packageIdentity}`)
  if (bytes.byteLength !== archive.sizeBytes)
    return fail(
      `size mismatch for ${packageIdentity}: expected ${archive.sizeBytes}, got ${bytes.byteLength}`,
    )
}

const parseBuckConfig = (text: string): Readonly<Record<string, string>> => {
  let section = ''
  const values: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') === true || line.startsWith(';') === true) continue
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line)
    if (sectionMatch !== null) {
      section = sectionMatch[1] ?? ''
      continue
    }
    const equals = line.indexOf('=')
    if (equals === -1) continue
    values[`${section}.${line.slice(0, equals).trim()}`] = line.slice(equals + 1).trim()
  }
  return values
}

/**
 * Resolve the seeder destination with the same precedence as Buck: explicit CI
 * environment, active local posture, active tracked posture, then the tracked
 * trusted-origin fallback used to generate local posture.
 */
export const resolveArchiveOrigin = ({
  env,
  localConfig,
  trackedConfig,
}: {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly localConfig: string
  readonly trackedConfig: string
}): ArchiveOrigin => {
  const local = parseBuckConfig(localConfig)
  const tracked = parseBuckConfig(trackedConfig)
  const urlPrefix =
    env['BUCK2_ARCHIVE_CAS_URL'] ??
    local['archive_origin.url_prefix'] ??
    tracked['archive_origin.url_prefix'] ??
    tracked['archive_origin.trusted_url_prefix']
  const tier =
    env['BUCK2_ARCHIVE_CAS_TIER'] ??
    local['archive_origin.tier'] ??
    tracked['archive_origin.tier'] ??
    tracked['archive_origin.trusted_tier']
  if (typeof urlPrefix !== 'string' || /^https?:\/\/.+\/cas\/$/u.test(urlPrefix) === false)
    return fail('archive origin URL must be an http(s) URL ending with /cas/')
  if (tier !== 'public' && tier !== 'private')
    return fail('archive origin tier must be public or private')
  return { tier, urlPrefix }
}

/** Verify an existing CAS object or upload a verified registry archive. */
export const seedArchive = async ({
  archive,
  fetchArchive = fetch,
  headers,
  packageIdentity,
  tier,
  urlPrefix,
}: {
  readonly archive: PnpmSha256Entry
  readonly fetchArchive?: typeof fetch
  readonly headers: Readonly<Record<string, string>> | undefined
  readonly packageIdentity: string
  readonly tier: 'public' | 'private'
  readonly urlPrefix: string
}): Promise<ArchiveSeedResult> => {
  assertArchiveAllowedForTier({ archive, packageIdentity, tier })
  if (archive.packageIdentity !== packageIdentity)
    return fail(`package identity mismatch for ${packageIdentity}`)

  const casUrl = `${urlPrefix}${archive.sha256}`
  const existing = await fetchArchive(casUrl, { headers, method: 'HEAD' })
  if (existing.status === 200) {
    const response = await fetchArchive(casUrl, { headers })
    if (response.ok === false)
      return fail(`CAS GET returned ${response.status} for ${packageIdentity}`)
    verifyArchive({
      archive,
      bytes: new Uint8Array(await response.arrayBuffer()),
      packageIdentity,
    })
    return 'present'
  }
  if (existing.status !== 404)
    return fail(`CAS lookup returned ${existing.status} for ${packageIdentity}`)

  const response = await fetchArchive(archive.registryUrl)
  if (response.ok === false)
    return fail(`registry returned ${response.status} for ${packageIdentity}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  verifyArchive({ archive, bytes, packageIdentity })

  const put = await fetchArchive(casUrl, { body: bytes, headers, method: 'PUT' })
  if (put.ok === false) return fail(`CAS PUT returned ${put.status} for ${packageIdentity}`)
  return 'uploaded'
}

const main = async (): Promise<void> => {
  const trackedConfig = await readFile('.buckconfig', 'utf8')
  const localConfig = await readFile('.buckconfig.local', 'utf8').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    throw error
  })
  const { tier, urlPrefix } = resolveArchiveOrigin({
    env: process.env,
    localConfig,
    trackedConfig,
  })

  const metadata = translatePnpmLock({
    lockfileText: await readFile('pnpm-lock.yaml', 'utf8'),
    workspaceText: await readFile('pnpm-workspace.yaml', 'utf8'),
  })
  const sidecar = decodePnpmSha256Sidecar(
    JSON.parse(await readFile('buck2/dependencies/pnpm-lock.sha256.json', 'utf8')),
  )
  validatePnpmSha256Sidecar({ metadata, sidecar })

  const authorization = process.env.BUCK2_ARCHIVE_CAS_AUTHORIZATION
  const headers = authorization === undefined ? undefined : { authorization }
  let present = 0
  let uploaded = 0
  const archives = Object.entries(sidecar.packages)
  const seedNext = async (index: number): Promise<void> => {
    const entry = archives[index]
    if (entry === undefined) return
    const [packageIdentity, archive] = entry
    const result = await seedArchive({
      archive,
      fetchArchive: fetch,
      headers,
      packageIdentity,
      tier,
      urlPrefix,
    })
    if (result === 'present') present += 1
    else uploaded += 1
    await seedNext(index + 1)
  }
  await seedNext(0)
  process.stdout.write(
    `pnpm archive seed complete: ${present} present, ${uploaded} uploaded, tier ${tier}\n`,
  )
}

if (import.meta.main) await main()
