import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { type PnpmLockfileV9, supportedPnpmVersion } from './model.ts'
import {
  PnpmPackageMaterializationError,
  compilePnpmTaskClosureFromArchives,
  materializePnpmPackageArchive,
  pnpmPackageMaterializerAbi,
} from './pnpm-materializer.ts'

const writeTarString = (block: Uint8Array, offset: number, length: number, value: string): void => {
  const bytes = Buffer.from(value)
  if (bytes.length > length) throw new Error(`Tar fixture field is too long: ${value}`)
  block.set(bytes, offset)
}

const writeTarOctal = (block: Uint8Array, offset: number, length: number, value: number): void =>
  writeTarString(block, offset, length, value.toString(8).padStart(length - 1, '0'))

const tarEntry = (name: string, bytes: Uint8Array, mode = 0o644): Uint8Array => {
  const header = new Uint8Array(512)
  writeTarString(header, 0, 100, name)
  writeTarOctal(header, 100, 8, mode)
  writeTarOctal(header, 108, 8, 0)
  writeTarOctal(header, 116, 8, 0)
  writeTarOctal(header, 124, 12, bytes.length)
  writeTarOctal(header, 136, 12, 0)
  header.fill(0x20, 148, 156)
  header[156] = '0'.charCodeAt(0)
  writeTarString(header, 257, 6, 'ustar')
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  writeTarString(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `)
  const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512)
  padded.set(bytes)
  const entry = new Uint8Array(header.length + padded.length)
  entry.set(header)
  entry.set(padded, header.length)
  return entry
}

const archive = (files: Readonly<Record<string, string>>): Uint8Array => {
  const entries = Object.entries(files).map(([name, value]) =>
    tarEntry(`package/${name}`, Buffer.from(value), name.endsWith('.sh') === true ? 0o755 : 0o644),
  )
  const size = entries.reduce((sum, entry) => sum + entry.length, 1024)
  const tar = new Uint8Array(size)
  let offset = 0
  for (const entry of entries) {
    tar.set(entry, offset)
    offset += entry.length
  }
  return gzipSync(tar)
}

const integrity = (bytes: Uint8Array): string =>
  `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const packageArchive = (depPath: string, files: Readonly<Record<string, string>>) => {
  const archiveBytes = archive(files)
  return {
    depPath,
    archiveBytes,
    sourceIntegrity: integrity(archiveBytes),
    buildPolicyDigest: 'sha256:policy-a',
  }
}

const fixture = () => {
  const alpha = packageArchive('alpha@1.0.0', { 'index.js': 'export const alpha = 1\n' })
  const child = packageArchive('child@1.0.0', { 'index.js': 'export const child = 1\n' })
  const unrelated = packageArchive('unrelated@9.0.0', { 'index.js': 'unrelated\n' })
  const lockfile: PnpmLockfileV9 = {
    lockfileVersion: '9.0',
    importers: {
      'packages/app': {
        dependencies: { alpha: { specifier: '1.0.0', version: '1.0.0' } },
      },
    },
    packages: {
      'alpha@1.0.0': { resolution: { integrity: alpha.sourceIntegrity } },
      'child@1.0.0': { resolution: { integrity: child.sourceIntegrity } },
      'unrelated@9.0.0': { resolution: { integrity: unrelated.sourceIntegrity } },
    },
    snapshots: {
      'alpha@1.0.0': { dependencies: { child: '1.0.0' } },
      'child@1.0.0': {},
      'unrelated@9.0.0': {},
    },
  }
  return { alpha, child, lockfile, unrelated }
}

const compile = (input = fixture()) =>
  compilePnpmTaskClosureFromArchives({
    pnpmVersion: supportedPnpmVersion,
    lockfile: input.lockfile,
    request: {
      label: '//packages/app:check',
      importerId: 'packages/app',
      mode: 'check',
      platformRole: 'exec',
      platform: { os: 'linux', cpu: 'x64', libc: 'glibc', nodeAbi: '137' },
      roots: [{ alias: 'alpha', field: 'dependencies', reason: 'static import' }],
    },
    workspaceLabels: {},
    archives: { 'alpha@1.0.0': input.alpha, 'child@1.0.0': input.child },
  })

const errorCode = (thunk: () => unknown): string | undefined => {
  try {
    thunk()
    return undefined
  } catch (error) {
    return error instanceof PnpmPackageMaterializationError ? error.code : undefined
  }
}

describe('pnpm package materialization', () => {
  it('verifies SRI and normalizes package paths, modes, and file bytes', () => {
    const input = packageArchive('alpha@1.0.0', {
      'bin/run.sh': '#!/bin/sh\nexit 0\n',
      'index.js': 'export {}\n',
    })
    const payload = materializePnpmPackageArchive(input)

    expect(payload.materializer).toEqual({
      abi: pnpmPackageMaterializerAbi,
      buildPolicyDigest: 'sha256:policy-a',
    })
    expect(payload.files.map(({ bytes: _bytes, ...file }) => file)).toMatchObject([
      { path: 'bin/run.sh', mode: 0o755 },
      { path: 'index.js', mode: 0o644 },
    ])

    const corrupted = Uint8Array.from(input.archiveBytes)
    const last = corrupted.at(-1)
    if (last === undefined) throw new Error('Archive fixture must not be empty')
    corrupted[corrupted.length - 1] = last ^ 1
    expect(
      errorCode(() =>
        materializePnpmPackageArchive({
          ...input,
          archiveBytes: corrupted,
        }),
      ),
    ).toBe('ARCHIVE_INTEGRITY_MISMATCH')
  })

  it('keeps exact closure identity stable for an unreachable lock/package mutation', () => {
    const baseline = fixture()
    const candidate = structuredClone(baseline)
    candidate.unrelated = packageArchive('unrelated@9.0.0', { 'index.js': 'changed\n' })
    candidate.lockfile.packages['unrelated@9.0.0']!.resolution.integrity =
      candidate.unrelated.sourceIntegrity

    expect(compile(candidate).task.id).toBe(compile(baseline).task.id)
  })

  it('changes exact closure identity for a reachable normalized package mutation', () => {
    const baseline = fixture()
    const candidate = structuredClone(baseline)
    candidate.child = packageArchive('child@1.0.0', { 'index.js': 'export const child = 2\n' })
    candidate.lockfile.packages['child@1.0.0']!.resolution.integrity =
      candidate.child.sourceIntegrity

    expect(compile(candidate).task.id).not.toBe(compile(baseline).task.id)
  })

  it('fails closed when a selected archive or selected dependency edge is missing', () => {
    const missingArchive = fixture()
    expect(
      errorCode(() =>
        compilePnpmTaskClosureFromArchives({
          pnpmVersion: supportedPnpmVersion,
          lockfile: missingArchive.lockfile,
          request: {
            label: '//packages/app:check',
            importerId: 'packages/app',
            mode: 'check',
            platformRole: 'exec',
            platform: { os: 'linux', cpu: 'x64' },
            roots: [{ alias: 'alpha', field: 'dependencies', reason: 'static import' }],
          },
          workspaceLabels: {},
          archives: { 'alpha@1.0.0': missingArchive.alpha },
        }),
      ),
    ).toBe('MISSING_MATERIALIZATION_RECEIPT')

    const missingEdge = fixture()
    delete missingEdge.lockfile.snapshots['child@1.0.0']
    expect(() => compile(missingEdge)).toThrow('Snapshot child@1.0.0 is absent')
  })

  it('rejects archive path ambiguity before normalized identity minting', () => {
    const ambiguousBytes = archive({ parent: 'file\n', 'parent/child': 'child\n' })
    expect(
      errorCode(() =>
        materializePnpmPackageArchive({
          archiveBytes: ambiguousBytes,
          sourceIntegrity: integrity(ambiguousBytes),
          buildPolicyDigest: 'sha256:policy-a',
        }),
      ),
    ).toBe('UNSAFE_ARCHIVE_PATH')
  })
})
