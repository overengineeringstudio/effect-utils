import { createHash, timingSafeEqual } from 'node:crypto'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'

import { canonicalSha256, compareCodeUnits, sortedRecord } from './canonical.ts'
import {
  type CompiledTaskClosure,
  type MaterializerIdentity,
  type PnpmLockfileV9,
  type TaskClosureRequest,
  type VerifiedNormalizedPayload,
} from './model.ts'
import {
  compilePnpmTaskClosure,
  discoverPnpmTaskClosureInputs,
  type PnpmTaskClosureInputPlan,
} from './pnpm-closure.ts'

/* oxlint-disable overeng/named-args -- Fixed-width tar parsing is clearer with positional offset/length helpers. */

/** Versioned identity for normalized npm registry package payloads. */
export const pnpmPackageMaterializerAbi = 'effect-utils.pnpm-package-tar.v1' as const

/** Fail-closed materializer boundary error classifications. */
export type PnpmPackageMaterializationErrorCode =
  | 'ARCHIVE_INTEGRITY_MISMATCH'
  | 'DUPLICATE_ARCHIVE_PATH'
  | 'EXTRA_MATERIALIZATION_RECEIPT'
  | 'INVALID_ARCHIVE'
  | 'MISSING_MATERIALIZATION_RECEIPT'
  | 'SOURCE_INTEGRITY_MISMATCH'
  | 'UNSAFE_ARCHIVE_PATH'
  | 'UNSUPPORTED_ARCHIVE_ENTRY'
  | 'UNSUPPORTED_SOURCE_INTEGRITY'

/** Structured materializer failure with stable code and bounded evidence. */
export class PnpmPackageMaterializationError extends Error {
  readonly code: PnpmPackageMaterializationErrorCode
  readonly evidence: Readonly<Record<string, string>>

  constructor(args: {
    readonly code: PnpmPackageMaterializationErrorCode
    readonly message: string
    readonly evidence?: Readonly<Record<string, string>>
  }) {
    super(args.message)
    this.name = 'PnpmPackageMaterializationError'
    this.code = args.code
    this.evidence = args.evidence ?? {}
  }
}

/** One canonical regular file in a normalized npm package payload. */
export interface NormalizedPackageFile {
  readonly path: string
  readonly mode: 0o644 | 0o755
  readonly size: number
  readonly sha256: `sha256:${string}`
  readonly bytes: Uint8Array
}

/** Verified content identity plus the normalized files it commits to. */
export interface MaterializedPnpmPackage extends VerifiedNormalizedPayload {
  readonly files: readonly NormalizedPackageFile[]
}

/** Portable receipt consumed by the authoritative closure compiler. */
export interface PnpmPackageMaterializationReceipt extends VerifiedNormalizedPayload {
  readonly depPath: string
  readonly sourceIntegrity: string
}

/** Immutable registry archive and package-local policy supplied to the join. */
export interface PnpmPackageArchiveInput {
  readonly depPath: string
  readonly sourceIntegrity: string
  readonly archiveBytes: Uint8Array
  readonly buildPolicyDigest: string
}

const fail = (
  code: PnpmPackageMaterializationErrorCode,
  message: string,
  evidence?: Readonly<Record<string, string>>,
): never => {
  throw new PnpmPackageMaterializationError({
    code,
    message,
    ...(evidence === undefined ? {} : { evidence }),
  })
}

const sha256 = (bytes: Uint8Array): `sha256:${string}` =>
  `sha256:${createHash('sha256').update(bytes).digest('hex')}`

const verifySha512Integrity = (bytes: Uint8Array, integrity: string): void => {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity)
  if (match === null) {
    throw new PnpmPackageMaterializationError({
      code: 'UNSUPPORTED_SOURCE_INTEGRITY',
      message: 'Expected one canonical sha512 SRI value',
      evidence: { integrity },
    })
  }
  const expected = Buffer.from(match[1]!, 'base64')
  const actual = createHash('sha512').update(bytes).digest()
  if (expected.length !== actual.length || timingSafeEqual(expected, actual) === false) {
    fail('ARCHIVE_INTEGRITY_MISMATCH', 'Registry archive does not match pnpm lock integrity', {
      integrity,
    })
  }
}

const tarString = (block: Uint8Array, start: number, length: number): string => {
  const field = block.subarray(start, start + length)
  const end = field.indexOf(0)
  return Buffer.from(end === -1 ? field : field.subarray(0, end)).toString('utf8')
}

const tarOctal = (block: Uint8Array, start: number, length: number, label: string): number => {
  const text = tarString(block, start, length).trim()
  if (/^[0-7]+$/.test(text) === false) fail('INVALID_ARCHIVE', `Invalid tar ${label}`)
  return Number.parseInt(text, 8)
}

const verifyTarChecksum = (block: Uint8Array): void => {
  const expected = tarOctal(block, 148, 8, 'checksum')
  let actual = 0
  for (let index = 0; index < 512; index++) {
    actual += index >= 148 && index < 156 ? 0x20 : block[index]!
  }
  if (actual !== expected) fail('INVALID_ARCHIVE', 'Tar header checksum mismatch')
}

const parsePax = (bytes: Uint8Array): Readonly<Record<string, string>> => {
  const text = Buffer.from(bytes).toString('utf8')
  const records: Array<readonly [string, string]> = []
  let offset = 0
  while (offset < text.length) {
    const space = text.indexOf(' ', offset)
    if (space === -1) fail('INVALID_ARCHIVE', 'Malformed PAX record length')
    const lengthText = text.slice(offset, space)
    if (/^[1-9][0-9]*$/.test(lengthText) === false) fail('INVALID_ARCHIVE', 'Malformed PAX length')
    const length = Number.parseInt(lengthText, 10)
    const record = text.slice(space + 1, offset + length)
    if (record.endsWith('\n') === false || offset + length > text.length) {
      fail('INVALID_ARCHIVE', 'Truncated PAX record')
    }
    const separator = record.indexOf('=')
    if (separator <= 0) fail('INVALID_ARCHIVE', 'Malformed PAX key/value')
    records.push([record.slice(0, separator), record.slice(separator + 1, -1)])
    offset += length
  }
  return Object.fromEntries(records)
}

const normalizedPackagePath = (archivePath: string): string | undefined => {
  if (archivePath === 'package' || archivePath === 'package/') return undefined
  if (archivePath.startsWith('package/') === false) {
    fail('UNSAFE_ARCHIVE_PATH', 'npm archive member must live below package/', { archivePath })
  }
  const stripped = archivePath.slice('package/'.length).replace(/\/$/, '')
  const normalized = path.posix.normalize(stripped)
  if (
    stripped === '' ||
    normalized !== stripped ||
    path.posix.isAbsolute(stripped) === true ||
    stripped === '..' ||
    stripped.startsWith('../') === true ||
    stripped.includes('\\') === true ||
    stripped.includes('\0') === true
  ) {
    fail('UNSAFE_ARCHIVE_PATH', 'npm archive member path is not canonical', { archivePath })
  }
  return stripped
}

/**
 * Verify a pnpm lock SRI and derive a canonical file payload directly from an
 * npm registry tarball. This prototype supports regular files and directories;
 * links and special entries fail closed until the real corpus proves a policy.
 */
export const materializePnpmPackageArchive = (args: {
  readonly archiveBytes: Uint8Array
  readonly sourceIntegrity: string
  readonly buildPolicyDigest: string
}): MaterializedPnpmPackage => {
  verifySha512Integrity(args.archiveBytes, args.sourceIntegrity)
  let tarBytes: Uint8Array
  try {
    tarBytes = gunzipSync(args.archiveBytes)
  } catch {
    return fail('INVALID_ARCHIVE', 'Registry archive is not valid gzip data')
  }

  const files: NormalizedPackageFile[] = []
  const seenPaths = new Set<string>()
  let offset = 0
  let terminated = false
  let pendingPax: Readonly<Record<string, string>> = {}
  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0) === true) {
      const trailing = tarBytes.subarray(offset)
      if (trailing.length < 1024 || trailing.every((byte) => byte === 0) === false) {
        fail('INVALID_ARCHIVE', 'Tar archive has an invalid terminator or trailing payload')
      }
      terminated = true
      break
    }
    verifyTarChecksum(header)
    const rawSize = tarOctal(header, 124, 12, 'size')
    const dataStart = offset + 512
    const dataEnd = dataStart + rawSize
    if (dataEnd > tarBytes.length) fail('INVALID_ARCHIVE', 'Truncated tar member')
    const data = tarBytes.subarray(dataStart, dataEnd)
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = tarString(header, 345, 155)
    const headerName = tarString(header, 0, 100)
    const rawPath = pendingPax.path ?? (prefix === '' ? headerName : `${prefix}/${headerName}`)

    if (type === 'x') {
      pendingPax = parsePax(data)
    } else {
      const packagePath = normalizedPackagePath(rawPath)
      pendingPax = {}
      if (type === '0' || type === '\0') {
        if (packagePath === undefined) {
          throw new PnpmPackageMaterializationError({
            code: 'UNSAFE_ARCHIVE_PATH',
            message: 'Package root cannot be a file',
          })
        }
        if (seenPaths.has(packagePath) === true) {
          fail('DUPLICATE_ARCHIVE_PATH', 'npm archive contains a duplicate path', { packagePath })
        }
        if (
          [...seenPaths].some(
            (seenPath) =>
              seenPath.startsWith(`${packagePath}/`) === true ||
              packagePath.startsWith(`${seenPath}/`) === true,
          ) === true
        ) {
          fail('UNSAFE_ARCHIVE_PATH', 'npm archive has a file/directory ancestor collision', {
            packagePath,
          })
        }
        seenPaths.add(packagePath)
        const mode = tarOctal(header, 100, 8, 'mode')
        files.push({
          path: packagePath,
          mode: (mode & 0o111) === 0 ? 0o644 : 0o755,
          size: data.length,
          sha256: sha256(data),
          bytes: Uint8Array.from(data),
        })
      } else if (type !== '5') {
        fail('UNSUPPORTED_ARCHIVE_ENTRY', `Unsupported npm archive entry type ${type}`, {
          archivePath: rawPath,
          type,
        })
      }
    }
    offset = dataStart + Math.ceil(rawSize / 512) * 512
  }
  if (terminated === false) fail('INVALID_ARCHIVE', 'Tar archive has no canonical terminator')
  if (files.length === 0) fail('INVALID_ARCHIVE', 'npm archive contains no package files')
  files.sort((left, right) => compareCodeUnits(left.path, right.path))
  const materializer: MaterializerIdentity = {
    abi: pnpmPackageMaterializerAbi,
    buildPolicyDigest: args.buildPolicyDigest,
  }
  const digest = `sha256:${canonicalSha256({
    schema: 1,
    materializer,
    files: files.map(({ bytes: _bytes, ...file }) => file),
  })}`
  return { digest, materializer, files }
}

/** Join an exact input plan to verified archive bytes and mint the closure. */
export const compilePnpmTaskClosureFromArchives = (options: {
  readonly pnpmVersion: string
  readonly lockfile: PnpmLockfileV9
  readonly request: TaskClosureRequest
  readonly workspaceLabels: Readonly<Record<string, string>>
  readonly archives: Readonly<Record<string, PnpmPackageArchiveInput>>
}): CompiledTaskClosure => {
  const plan = discoverPnpmTaskClosureInputs(options)
  const selected = new Set(plan.packages.map((pkg) => pkg.depPath))
  for (const depPath of Object.keys(options.archives)) {
    if (selected.has(depPath) === false) {
      fail('EXTRA_MATERIALIZATION_RECEIPT', `Archive input ${depPath} is outside the exact plan`, {
        depPath,
      })
    }
  }
  const normalizedPayloads = sortedRecord(
    plan.packages.map((pkg) => {
      const archive = options.archives[pkg.depPath]
      if (archive === undefined) {
        throw new PnpmPackageMaterializationError({
          code: 'MISSING_MATERIALIZATION_RECEIPT',
          message: `Package ${pkg.depPath} has no archive input`,
          evidence: { depPath: pkg.depPath },
        })
      }
      if (archive.depPath !== pkg.depPath) {
        fail('SOURCE_INTEGRITY_MISMATCH', `Package ${pkg.depPath} archive carries another path`, {
          actual: archive.depPath,
          expected: pkg.depPath,
        })
      }
      const expectedIntegrity = pkg.sourceResolution.integrity
      if (expectedIntegrity === undefined) {
        throw new PnpmPackageMaterializationError({
          code: 'UNSUPPORTED_SOURCE_INTEGRITY',
          message: `Package ${pkg.depPath} has no registry integrity`,
          evidence: { depPath: pkg.depPath },
        })
      }
      if (archive.sourceIntegrity !== expectedIntegrity) {
        fail('SOURCE_INTEGRITY_MISMATCH', `Package ${pkg.depPath} archive uses another integrity`, {
          actual: archive.sourceIntegrity,
          depPath: pkg.depPath,
          expected: expectedIntegrity,
        })
      }
      const payload = materializePnpmPackageArchive({
        archiveBytes: archive.archiveBytes,
        sourceIntegrity: archive.sourceIntegrity,
        buildPolicyDigest: archive.buildPolicyDigest,
      })
      return [pkg.depPath, payload] as const
    }),
  )
  return compilePnpmTaskClosure({ ...options, normalizedPayloads })
}

/** Plan type re-export seam used by generated package projections. */
export type ExactPnpmMaterializationPlan = PnpmTaskClosureInputPlan
