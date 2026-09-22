import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'

import {
  decodePnpmSha256Sidecar,
  translatePnpmLock,
  validatePnpmSha256Sidecar,
  type PnpmSha256Entry,
} from './pnpm-lock.ts'

const fail = (message: string): never => {
  throw new Error(`pnpm archive seeder: ${message}`)
}

const sha = (algorithm: 'sha256' | 'sha512', bytes: Uint8Array): string =>
  createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex')

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

export const verifyArchive = ({
  archive,
  bytes,
  packageIdentity,
}: {
  archive: PnpmSha256Entry
  bytes: Uint8Array
  packageIdentity: string
}): void => {
  const integrity = `sha512-${sha('sha512', bytes)}`
  const digest = sha('sha256', bytes)
  if (integrity !== archive.integrity)
    return fail(`lock SHA-512 mismatch for ${packageIdentity}`)
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
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
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

const main = async (): Promise<void> => {
  const config = parseBuckConfig(await readFile('.buckconfig', 'utf8'))
  const urlPrefix = process.env.BUCK2_ARCHIVE_CAS_URL ?? config['archive_origin.url_prefix']
  const tier = process.env.BUCK2_ARCHIVE_CAS_TIER ?? config['archive_origin.tier']
  if (typeof urlPrefix !== 'string' || /^https?:\/\/.+\/cas\/$/.test(urlPrefix) === false)
    return fail('archive origin URL must be an http(s) URL ending with /cas/')
  if (tier !== 'public' && tier !== 'private')
    return fail('archive origin tier must be public or private')

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
  for (const [packageIdentity, archive] of Object.entries(sidecar.packages)) {
    assertArchiveAllowedForTier({ archive, packageIdentity, tier })
    if (archive.packageIdentity !== packageIdentity)
      return fail(`package identity mismatch for ${packageIdentity}`)

    const casUrl = `${urlPrefix}${archive.sha256}`
    const existing = await fetch(casUrl, { headers, method: 'HEAD' })
    if (existing.status === 200) {
      present += 1
      continue
    }
    if (existing.status !== 404)
      return fail(`CAS lookup returned ${existing.status} for ${packageIdentity}`)

    const response = await fetch(archive.registryUrl)
    if (response.ok === false)
      return fail(`registry returned ${response.status} for ${packageIdentity}`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    verifyArchive({ archive, bytes, packageIdentity })

    const put = await fetch(casUrl, { body: bytes, headers, method: 'PUT' })
    if (put.ok === false) return fail(`CAS PUT returned ${put.status} for ${packageIdentity}`)
    uploaded += 1
  }
  process.stdout.write(`pnpm archive seed complete: ${present} present, ${uploaded} uploaded, tier ${tier}\n`)
}

if (import.meta.main) await main()
