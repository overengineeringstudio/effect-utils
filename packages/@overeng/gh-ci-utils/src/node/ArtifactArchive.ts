import type { Readable } from 'node:stream'
import { crc32, createInflateRaw } from 'node:zlib'

import { Effect } from 'effect'
import {
  fromBufferPromise,
  getFileNameLowLevel,
  parseExtraFields,
  type Entry,
  type ZipFile,
} from 'yauzl'

import {
  ARTIFACT_LIMITS,
  ArtifactError,
  type ArtifactMember,
  type ArtifactSelection,
} from '../isomorphic/Artifacts.ts'

/** Exact portable paths only: no normalization, alternate separators, or terminal controls. */
export const validateArtifactMemberPath = (path: string): boolean => {
  if (
    path.length === 0 ||
    Buffer.byteLength(path) > ARTIFACT_LIMITS.pathBytes ||
    path !== path.normalize('NFC') ||
    /[\\:\p{Cc}\u2028\u2029\p{Cf}]/u.test(path) ||
    path.startsWith('/')
  )
    return false
  const components = (path.endsWith('/') ? path.slice(0, -1) : path).split('/')
  return components.every((part) => part !== '' && part !== '.' && part !== '..')
}

const containsBinaryControls = (text: string): boolean => {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (
      code <= 8 ||
      code === 11 ||
      code === 12 ||
      (code >= 14 && code <= 26) ||
      (code >= 28 && code <= 31) ||
      code === 127
    )
      return true
  }
  return false
}

const failure = ({
  selection,
  reason,
  message,
  member = null,
}: {
  readonly selection: ArtifactSelection
  readonly reason: ArtifactError['reason']
  readonly message: string
  readonly member?: string | null
}) => new ArtifactError({ ...selection, reason, message, member })

const isBoundedInteger = ({
  value,
  maximum,
}: {
  readonly value: unknown
  readonly maximum: number
}): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum

/** Validate the entire directory before exposing any member or opening any content stream. */
const enumerate = async ({
  zip,
  selection,
  signal,
}: {
  readonly zip: ZipFile
  readonly selection: ArtifactSelection
  readonly signal: AbortSignal
}) => {
  if (!isBoundedInteger({ value: zip.entryCount, maximum: Number.MAX_SAFE_INTEGER })) {
    throw failure({ selection, reason: 'unsafe-archive', message: 'Invalid archive entry count' })
  }
  if (zip.entryCount > ARTIFACT_LIMITS.entries) {
    throw failure({
      selection: selection,
      reason: 'limit-exceeded',
      message: 'Archive exceeds the 1024-member limit',
    })
  }
  const entries: Entry[] = []
  const names = new Set<string>()
  for await (const entry of zip.eachEntry()) {
    signal.throwIfAborted()
    if (entries.length >= ARTIFACT_LIMITS.entries) {
      throw failure({
        selection: selection,
        reason: 'limit-exceeded',
        message: 'Archive exceeds the 1024-member limit',
      })
    }
    if (
      !isBoundedInteger({ value: zip.readEntryCursor, maximum: zip.fileSize }) ||
      !isBoundedInteger({ value: zip.entriesRead, maximum: ARTIFACT_LIMITS.entries }) ||
      !isBoundedInteger({ value: entry.relativeOffsetOfLocalHeader, maximum: zip.fileSize }) ||
      !isBoundedInteger({ value: entry.compressedSize, maximum: zip.fileSize }) ||
      !isBoundedInteger({ value: entry.uncompressedSize, maximum: 0xffffffff })
    ) {
      throw failure({
        selection,
        reason: 'unsafe-archive',
        message: 'Member metadata exceeds safe archive bounds',
      })
    }
    if (!validateArtifactMemberPath(entry.fileName)) {
      throw failure({
        selection: selection,
        reason: 'unsafe-archive',
        message: 'Archive contains an unsafe member path',
      })
    }
    // Reject a directory/file pair too: both address the same normalized path.
    const key = entry.fileName.replace(/\/$/u, '')
    if (names.has(key))
      throw failure({
        selection: selection,
        reason: 'unsafe-archive',
        message: 'Archive contains duplicate member paths',
      })
    names.add(key)
    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000
    if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
      throw failure({
        selection: selection,
        reason: 'unsupported-archive',
        message: 'Archive contains a symlink or special file',
      })
    }
    if (
      ((unixType === 0o040000 || (entry.externalFileAttributes & 0x10) !== 0) &&
        !entry.fileName.endsWith('/')) ||
      (unixType === 0o100000 && entry.fileName.endsWith('/'))
    ) {
      throw failure({
        selection: selection,
        reason: 'unsafe-archive',
        message: 'Archive directory attributes disagree with its path',
      })
    }
    if (
      entry.isEncrypted() ||
      (entry.generalPurposeBitFlag & ~0x080e) !== 0 ||
      (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) ||
      entry.versionNeededToExtract > 20 ||
      entry.extraFields.some((field) => field.id === 1)
    )
      throw failure({
        selection: selection,
        reason: 'unsupported-archive',
        message:
          'Only unencrypted stored/DEFLATE members without ZIP64 member fields are supported',
      })
    const local = await zip.readLocalFileHeaderPromise(entry)
    signal.throwIfAborted()
    if (
      !isBoundedInteger({ value: local.fileDataStart, maximum: zip.fileSize }) ||
      entry.compressedSize > zip.fileSize - local.fileDataStart ||
      !isBoundedInteger({ value: local.compressedSize, maximum: zip.fileSize }) ||
      !isBoundedInteger({ value: local.uncompressedSize, maximum: 0xffffffff })
    ) {
      throw failure({
        selection,
        reason: 'unsafe-archive',
        message: 'Local member metadata exceeds safe archive bounds',
      })
    }
    const localExtras = parseExtraFields(local.extraField)
    if (localExtras.some((field) => field.id === 1)) {
      throw failure({
        selection: selection,
        reason: 'unsupported-archive',
        message: 'ZIP64 local headers are unsupported',
      })
    }
    if (
      !local.fileName.equals(entry.fileNameRaw) ||
      getFileNameLowLevel(local.generalPurposeBitFlag, local.fileName, localExtras, true) !==
        entry.fileName ||
      local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
      local.compressionMethod !== entry.compressionMethod ||
      local.versionNeededToExtract !== entry.versionNeededToExtract
    )
      throw failure({
        selection: selection,
        reason: 'unsafe-archive',
        message: 'ZIP local and central member headers disagree',
      })
    const descriptor = (entry.generalPurposeBitFlag & 8) !== 0
    if (
      ((!descriptor || local.crc32 !== 0) && local.crc32 !== entry.crc32) ||
      ((!descriptor || local.compressedSize !== 0) &&
        local.compressedSize !== entry.compressedSize) ||
      ((!descriptor || local.uncompressedSize !== 0) &&
        local.uncompressedSize !== entry.uncompressedSize)
    )
      throw failure({
        selection: selection,
        reason: 'unsafe-archive',
        message: 'ZIP local and central member sizes or CRC disagree',
      })
    entries.push(entry)
  }
  return entries
}

const withArchive = <T>({
  bytes,
  selection,
  member,
  consume,
}: {
  readonly bytes: Uint8Array
  readonly selection: ArtifactSelection
  readonly member: string | null
  readonly consume: (zip: ZipFile, entries: readonly Entry[], signal: AbortSignal) => Promise<T>
}) =>
  Effect.tryPromise({
    try: async (signal) => {
      if (bytes.byteLength > ARTIFACT_LIMITS.compressedBytes) {
        throw failure({
          selection: selection,
          reason: 'limit-exceeded',
          message: 'Archive exceeds the 32 MiB compressed-byte limit',
          member: member,
        })
      }
      const zip = await fromBufferPromise(
        Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        {
          lazyEntries: true,
          autoClose: false,
          strictFileNames: true,
          validateEntrySizes: true,
        },
      )
      const close = () => zip.close()
      signal.addEventListener('abort', close, { once: true })
      try {
        signal.throwIfAborted()
        if (
          zip.fileSize !== bytes.byteLength ||
          !isBoundedInteger({ value: zip.readEntryCursor, maximum: bytes.byteLength })
        ) {
          throw failure({
            selection,
            reason: 'unsafe-archive',
            message: 'Directory offset exceeds safe archive bounds',
          })
        }
        return await consume(zip, await enumerate({ zip, selection, signal }), signal)
      } finally {
        signal.removeEventListener('abort', close)
        zip.close()
      }
    },
    catch: (cause) =>
      cause instanceof ArtifactError
        ? cause
        : failure({
            selection: selection,
            reason: 'unsafe-archive',
            message: 'Invalid or inconsistent ZIP archive',
            member: member,
          }),
  })

/** Metadata enumeration never opens or decompresses member streams. */
export const listArtifactMembers = Effect.fn('artifacts.list-members')(
  (bytes: Uint8Array, selection: ArtifactSelection) =>
    withArchive({
      bytes: bytes,
      selection: selection,
      member: null,
      consume: async (_zip, entries) =>
        entries.map(
          (entry): ArtifactMember => ({
            path: entry.fileName,
            compressedBytes: entry.compressedSize,
            decompressedBytes: entry.uncompressedSize,
            directory: entry.fileName.endsWith('/'),
          }),
        ),
    }),
)

/** Read one exact text member; no filesystem extraction and no unbounded inflate result. */
export const readArtifactMember = Effect.fn('artifacts.read-member')(
  (bytes: Uint8Array, selection: ArtifactSelection, member: string) =>
    withArchive({
      bytes: bytes,
      selection: selection,
      member: member,
      consume: async (zip, entries, signal) => {
        if (!validateArtifactMemberPath(member) || member.endsWith('/')) {
          throw failure({
            selection: selection,
            reason: 'invalid-selection',
            message: 'Select an exact safe file member path',
            member: member,
          })
        }
        const entry = entries.find((candidate) => candidate.fileName === member)
        if (!entry)
          throw failure({
            selection: selection,
            reason: 'member-not-found',
            message: 'Selected archive member was not found',
            member: member,
          })
        if (entry.uncompressedSize > ARTIFACT_LIMITS.memberBytes) {
          throw failure({
            selection: selection,
            reason: 'limit-exceeded',
            message: 'Member exceeds the 8 MiB decompressed-byte limit',
            member: member,
          })
        }
        if (entry.uncompressedSize > ARTIFACT_LIMITS.outputBytes) {
          throw failure({
            selection: selection,
            reason: 'limit-exceeded',
            message: 'Member exceeds the 256 KiB output-byte limit',
            member: member,
          })
        }
        const raw: Readable = await zip.openReadStreamPromise(entry, { decodeFileData: false })
        // Own the inflater so cancellation closes it as well as yauzl's raw member stream.
        const inflater =
          entry.compressionMethod === 8 ? createInflateRaw({ chunkSize: 16 * 1024 }) : undefined
        const forwardError = (error: Error) => {
          inflater?.destroy(error)
        }
        raw.on('error', forwardError)
        const stream = inflater === undefined ? raw : raw.pipe(inflater)
        const destroy = () => {
          raw.destroy()
          inflater?.destroy()
        }
        signal.addEventListener('abort', destroy, { once: true })
        const chunks: Buffer[] = []
        let size = 0
        let checksum = 0
        try {
          signal.throwIfAborted()
          // Streaming zlib bounds output chunks; never materialize an unbounded inflate result.
          for await (const chunk of stream) {
            signal.throwIfAborted()
            const data: Buffer = chunk
            if (
              data.length > ARTIFACT_LIMITS.memberBytes - size ||
              data.length > ARTIFACT_LIMITS.outputBytes - size
            ) {
              throw failure({
                selection: selection,
                reason: 'limit-exceeded',
                message: 'Member stream exceeds the decompression/output limit',
                member: member,
              })
            }
            if (data.length > entry.uncompressedSize - size) {
              throw failure({
                selection: selection,
                reason: 'unsafe-archive',
                message: 'Member stream exceeds its declared decompressed size',
                member: member,
              })
            }
            size += data.length
            checksum = crc32(data, checksum)
            chunks.push(data)
          }
        } finally {
          signal.removeEventListener('abort', destroy)
          destroy()
          raw.removeListener('error', forwardError)
        }
        if (size !== entry.uncompressedSize || checksum !== entry.crc32) {
          throw failure({
            selection: selection,
            reason: 'unsafe-archive',
            message: 'Member size or CRC integrity check failed',
            member: member,
          })
        }
        let text: string
        try {
          text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
            Buffer.concat(chunks, size),
          )
        } catch {
          throw failure({
            selection: selection,
            reason: 'binary-content',
            message: 'Selected member is not UTF-8 text',
            member: member,
          })
        }
        if (containsBinaryControls(text)) {
          throw failure({
            selection: selection,
            reason: 'binary-content',
            message: 'Selected member contains binary control bytes',
            member: member,
          })
        }
        return { path: member, text, decompressedBytes: size }
      },
    }),
)
