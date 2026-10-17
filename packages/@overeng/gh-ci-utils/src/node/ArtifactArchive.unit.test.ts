import { describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { expect } from 'vitest'

import { ARTIFACT_LIMITS } from '../isomorphic/Artifacts.ts'
import { basic, binary, bomb, duplicate, makeZip, traversal } from './ArtifactArchive.fixtures.ts'
import {
  listArtifactMembers,
  readArtifactMember,
  validateArtifactMemberPath,
} from './ArtifactArchive.ts'

const selection = { repo: 'example-org/example-repo', runId: 123, artifactId: 456 }
const central = basic.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
const descriptor = Buffer.from(
  'UEsDBBQACAAIAAk5UF0AAAAAAAAAAAAAAAAOAAAAZGVzY3JpcHRvci50eHQrLilKTcxNTVEoSa0o4QIAUEsHCMI7k1YQAAAADgAAAFBLAQIUAxQACAAIAAk5UF3CO5NWEAAAAA4AAAAOAAAAAAAAAAAAAACAAQAAAABkZXNjcmlwdG9yLnR4dFBLBQYAAAAAAQABADwAAABMAAAAAAA=',
  'base64',
)
const stored = Buffer.from(
  'UEsDBBQAAAAAAAk5UF2R7tOJDAAAAAwAAAAKAAAAc3RvcmVkLnR4dHN0b3JlZCB0ZXh0ClBLAQIUAxQAAAAAAAk5UF2R7tOJDAAAAAwAAAAKAAAAAAAAAAAAAACAAQAAAABzdG9yZWQudHh0UEsFBgAAAAABAAEAOAAAADQAAAAAAA==',
  'base64',
)
const directoryPair = Buffer.from(
  'UEsDBBQAAAAIAAk5UF0AAAAAAgAAAAAAAAAHAAAAZm9sZGVyLwMAUEsDBBQAAAAIAAk5UF0QNp+MBgAAAAQAAAAGAAAAZm9sZGVyS8vMSQUAUEsBAhQDFAAAAAgACTlQXQAAAAACAAAAAAAAAAcAAAAAAAAAAAAQAP1BAAAAAGZvbGRlci9QSwECFAMUAAAACAAJOVBdEDafjAYAAAAEAAAABgAAAAAAAAAAAAAAgAEnAAAAZm9sZGVyUEsFBgAAAAACAAIAaQAAAFEAAAAAAA==',
  'base64',
)
// Python stdlib zipfile with ZIP_FILECOUNT_LIMIT=0: ordinary member, ZIP64 directory.
const zip64Directory = Buffer.from(
  'UEsDBBQAAAAIAO1CUF2m7oWBDwAAAA0AAAAJAAAAY29zdC5qc29uq1YqyS9JzFGyMjSq5QIAUEsBAhQDFAAAAAgA7UJQXabuhYEPAAAADQAAAAkAAAAAAAAAAAAAAIABAAAAAGNvc3QuanNvblBLBgYsAAAAAAAAAC0ALQAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAA3AAAAAAAAADYAAAAAAAAAUEsGBwAAAABtAAAAAAAAAAEAAABQSwUGAAAAAAEAAQA3AAAANgAAAAAA',
  'base64',
)

// Mutations use fixed offsets into the synthetic ZIP, not a container implementation.
const changed = (updates: readonly { offset: number; value: number; width: 2 | 4 }[]) => {
  const bytes = Buffer.from(basic)
  for (const update of updates) {
    if (update.width === 2) bytes.writeUInt16LE(update.value, update.offset)
    else bytes.writeUInt32LE(update.value, update.offset)
  }
  return bytes
}

describe('retained artifact archive', () => {
  it.effect('reads the tail of a large member without raising the output or member ceilings', () =>
    Effect.gen(function* () {
      const text = 'a'.repeat(569_000) + '\nlast log line\n'
      const bytes = makeZip(text)
      expect((yield* readArtifactMember(bytes, selection, 'log.txt', { tailBytes: 15 })).text).toBe(
        '\nlast log line\n',
      )
      const content = yield* readArtifactMember(bytes, selection, 'log.txt', { tailBytes: 15 })
      expect(content.window).toEqual({
        offset: text.length - 15,
        length: 15,
        totalBytes: text.length,
      })
      expect(content.decompressedBytes).toBe(text.length)
      expect(
        (yield* readArtifactMember(bytes, selection, 'log.txt').pipe(Effect.flip)).reason,
      ).toBe('limit-exceeded')
    }),
  )

  it.effect('aligns UTF-8 edges inward and reports actual decompressed byte ranges', () =>
    Effect.gen(function* () {
      const bytes = makeZip('aé界😀z')
      for (const [window, text, offset, length] of [
        [{ offset: 0, length: 12 }, 'aé界😀z', 0, 11],
        [{ offset: 2, length: 7 }, '界', 3, 3],
        [{ offset: 4, length: 1 }, '', 6, 0],
        [{ offset: 7, length: 0 }, '', 10, 0],
        [{ tailBytes: 4 }, 'z', 10, 1],
        [{ offset: Number.MAX_SAFE_INTEGER, length: 5 }, '', 11, 0],
        [{ offset: 0, length: 0 }, '', 0, 0],
      ] as const) {
        const content = yield* readArtifactMember(bytes, selection, 'log.txt', window)
        expect(content.text).toBe(text)
        expect(content.window).toEqual({ offset, length, totalBytes: 11 })
      }
    }),
  )

  it.effect('validates UTF-8 and binary controls outside the returned window', () =>
    Effect.gen(function* () {
      for (const content of [
        Buffer.from([0xff, 0x61]),
        Buffer.from([0, 0x61]),
        Buffer.from([0x61, 0xff]),
        Buffer.from([0x61, 0]),
      ]) {
        const failure = yield* readArtifactMember(makeZip(content), selection, 'log.txt', {
          offset: 1,
          length: 0,
        }).pipe(Effect.flip)
        expect(failure.reason).toBe('binary-content')
      }
      const split = 'a'.repeat(16 * 1024 - 1) + '😀end'
      expect(
        (yield* readArtifactMember(makeZip(split), selection, 'log.txt', { tailBytes: 7 })).text,
      ).toBe('😀end')
    }),
  )

  it.effect('still verifies whole-member CRC for tiny and empty windows', () =>
    Effect.gen(function* () {
      const bytes = makeZip('a'.repeat(300_000) + 'end')
      const directory = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      bytes.writeUInt32LE(0, 14)
      bytes.writeUInt32LE(0, directory + 16)
      for (const tailBytes of [0, 3]) {
        const failure = yield* readArtifactMember(bytes, selection, 'log.txt', { tailBytes }).pipe(
          Effect.flip,
        )
        expect(failure.reason).toBe('unsafe-archive')
      }
    }),
  )

  it.effect('rejects oversized window requests and never bypasses the 8 MiB member cap', () =>
    Effect.gen(function* () {
      for (const window of [
        { offset: -1, length: 1 },
        { offset: 0, length: ARTIFACT_LIMITS.outputBytes + 1 },
        { tailBytes: ARTIFACT_LIMITS.outputBytes + 1 },
        { tailBytes: 1.5 },
      ]) {
        expect(
          (yield* readArtifactMember(basic, selection, 'cost.json', window).pipe(Effect.flip))
            .reason,
        ).toBe('invalid-selection')
      }
      expect(
        (yield* readArtifactMember(bomb, selection, 'bomb.txt', { tailBytes: 1 }).pipe(Effect.flip))
          .reason,
      ).toBe('limit-exceeded')
      const content = yield* readArtifactMember(
        makeZip('x'.repeat(300_000)),
        selection,
        'log.txt',
        {
          offset: 0,
          length: ARTIFACT_LIMITS.outputBytes,
        },
      )
      expect(content.text.length).toBe(ARTIFACT_LIMITS.outputBytes)
    }),
  )

  it.effect(
    'lists metadata without decompressing content and reads exact synthetic text with provenance',
    () =>
      Effect.gen(function* () {
        const members = yield* listArtifactMembers(basic, selection)
        expect(members.map((entry) => entry.path)).toEqual(['cost.json', 'trace/provider.json'])
        const content = yield* readArtifactMember(basic, selection, 'cost.json')
        expect(content).toEqual({
          path: 'cost.json',
          text: '{"total":12}\n',
          decompressedBytes: 13,
        })
      }),
  )

  it.effect('supports bounded ZIP64 directories without ZIP64 member fields', () =>
    Effect.gen(function* () {
      const members = yield* listArtifactMembers(zip64Directory, selection)
      expect(members).toEqual([
        { path: 'cost.json', compressedBytes: 15, decompressedBytes: 13, directory: false },
      ])
      expect((yield* readArtifactMember(zip64Directory, selection, 'cost.json')).text).toBe(
        '{"total":12}\n',
      )
    }),
  )

  it.effect('rejects malformed or out-of-budget ZIP64 directory metadata', () =>
    Effect.gen(function* () {
      const record = zip64Directory.length - 98
      for (const [offset, value, reason] of [
        [record + 32, 1025n, 'limit-exceeded'],
        [record + 32, 9007199254740992n, 'unsafe-archive'],
        [record + 48, BigInt(zip64Directory.length + 1), 'unsafe-archive'],
        [record + 64, BigInt(zip64Directory.length + 1), 'unsafe-archive'],
        [record + 48, 9007199254740992n, 'unsafe-archive'],
      ] as const) {
        const malformed = Buffer.from(zip64Directory)
        malformed.writeBigUInt64LE(value, offset)
        expect((yield* listArtifactMembers(malformed, selection).pipe(Effect.flip)).reason).toBe(
          reason,
        )
      }
      const zip64Entry = changed([
        { offset: 4, value: 45, width: 2 },
        { offset: central + 6, value: 45, width: 2 },
      ])
      expect((yield* listArtifactMembers(zip64Entry, selection).pipe(Effect.flip)).reason).toBe(
        'unsupported-archive',
      )
    }),
  )

  it.effect('supports stored members and streaming data descriptors', () =>
    Effect.gen(function* () {
      expect((yield* readArtifactMember(stored, selection, 'stored.txt')).text).toBe(
        'stored text\n',
      )
      expect((yield* readArtifactMember(descriptor, selection, 'descriptor.txt')).text).toBe(
        'streamed text\n',
      )
      expect((yield* listArtifactMembers(directoryPair, selection).pipe(Effect.flip)).reason).toBe(
        'unsafe-archive',
      )
    }),
  )

  it.effect('can list a highly compressible oversized member without decompressing it', () =>
    Effect.gen(function* () {
      expect(bomb.length).toBeLessThan(320000)
      const members = yield* listArtifactMembers(bomb, selection)
      expect(members[0]?.decompressedBytes).toBe(ARTIFACT_LIMITS.memberBytes + 1)
      const failure = yield* readArtifactMember(bomb, selection, 'bomb.txt').pipe(Effect.flip)
      expect(failure).toMatchObject({ ...selection, member: 'bomb.txt', reason: 'limit-exceeded' })
    }),
  )

  it.effect(
    'rejects duplicate names, traversal, encrypted entries, special files, and unsupported methods',
    () =>
      Effect.gen(function* () {
        const encrypted = changed([
          { offset: 6, value: 1, width: 2 },
          { offset: central + 8, value: 1, width: 2 },
        ])
        const symlink = changed([{ offset: central + 38, value: 0o120777 * 65536, width: 4 }])
        const method = changed([
          { offset: 8, value: 99, width: 2 },
          { offset: central + 10, value: 99, width: 2 },
        ])
        for (const bytes of [duplicate, traversal, encrypted, symlink, method]) {
          const failure = yield* listArtifactMembers(bytes, selection).pipe(Effect.flip)
          expect(['unsafe-archive', 'unsupported-archive']).toContain(failure.reason)
          expect(failure).toMatchObject(selection)
        }
      }),
  )

  it.effect('rejects central/local disagreement, truncated ZIPs, and CRC corruption', () =>
    Effect.gen(function* () {
      const mismatch = changed([{ offset: 8, value: 0, width: 2 }])
      const crcCorrupt = changed([
        { offset: 14, value: 0, width: 4 },
        { offset: central + 16, value: 0, width: 4 },
      ])
      for (const bytes of [mismatch, basic.subarray(0, basic.length - 20), crcCorrupt]) {
        const failure = yield* readArtifactMember(bytes, selection, 'cost.json').pipe(Effect.flip)
        expect(failure.reason).toBe('unsafe-archive')
      }
    }),
  )

  it.effect('rejects unsafe selection, missing members, and binary content', () =>
    Effect.gen(function* () {
      expect(
        (yield* readArtifactMember(basic, selection, '../cost.json').pipe(Effect.flip)).reason,
      ).toBe('invalid-selection')
      expect(
        (yield* readArtifactMember(basic, selection, 'missing.json').pipe(Effect.flip)).reason,
      ).toBe('member-not-found')
      expect(
        (yield* readArtifactMember(binary, selection, 'binary.dat').pipe(Effect.flip)).reason,
      ).toBe('binary-content')
    }),
  )

  it.effect('rejects archive and entry-count ceilings before exposing metadata', () =>
    Effect.gen(function* () {
      const tooMany = Buffer.from(basic)
      tooMany.writeUInt16LE(1025, tooMany.length - 14)
      tooMany.writeUInt16LE(1025, tooMany.length - 12)
      expect((yield* listArtifactMembers(tooMany, selection).pipe(Effect.flip)).reason).toBe(
        'limit-exceeded',
      )
      const oversized = new Uint8Array(ARTIFACT_LIMITS.compressedBytes + 1)
      expect((yield* listArtifactMembers(oversized, selection).pipe(Effect.flip)).reason).toBe(
        'limit-exceeded',
      )
    }),
  )

  it.effect('rejects forged member size in a sub-320000-byte compressed bomb while inflating', () =>
    Effect.gen(function* () {
      const forged = Buffer.from(bomb)
      const directory = forged.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
      forged.writeUInt32LE(1, 22)
      forged.writeUInt32LE(1, directory + 24)
      const failure = yield* readArtifactMember(forged, selection, 'bomb.txt').pipe(Effect.flip)
      expect(['unsafe-archive', 'limit-exceeded']).toContain(failure.reason)
    }),
  )

  it.effect('cancels asynchronous archive work without stranding subsequent reads', () =>
    Effect.gen(function* () {
      const pending = yield* readArtifactMember(basic, selection, 'cost.json').pipe(
        Effect.forkChild,
      )
      yield* Effect.yieldNow
      yield* Fiber.interrupt(pending)
      expect((yield* readArtifactMember(basic, selection, 'cost.json')).text).toBe('{"total":12}\n')
    }),
  )

  it('requires exact portable normalized paths', () => {
    for (const path of [
      '',
      '/',
      '/cost.json',
      'a//b',
      'a/./b',
      'a/../b',
      'a\\b',
      'C:cost.json',
      '\u001b[0m',
      'e\u0301.json',
    ]) {
      expect(validateArtifactMemberPath(path), path).toBe(false)
    }
    expect(validateArtifactMemberPath('trace/provider.json')).toBe(true)
    expect(validateArtifactMemberPath('trace/')).toBe(true)
  })
})
