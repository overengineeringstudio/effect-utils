import { Buffer } from 'node:buffer'

import { describe, it } from '@effect/vitest'
import { Schema } from 'effect'
import { expect } from 'vitest'

import {
  OwnedCpAMountMetadata,
  R6Manifest,
  canonicalizeR6Entries,
  digestR6Manifest,
  encodeOwnedMountMemberFilename,
  encodeR6ManifestFramed,
  makeR6Manifest,
  ownedCpAMountMetadataPath,
  validateR6SymlinkTarget,
  type R6FileEntry,
  type R6ManifestEntry,
} from './member-mount-r6.ts'

const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`

const file = (path: string, payload = hash('a')): R6FileEntry => ({
  path,
  kind: 'file',
  mode: 0o444,
  payload,
})

const link = (path: string, target: string): R6ManifestEntry => ({
  path,
  kind: 'symlink',
  mode: null,
  payload: target,
})

describe('member-mount R6 canonical encoding', () => {
  it('byte-sorts canonical UTF-8 paths independently of input order', () => {
    const first = makeR6Manifest([file('z'), file('a'), file('é')])
    const second = makeR6Manifest([file('e\u0301'), file('z'), file('a')])

    expect(first.entries.map((entry) => entry.path)).toEqual(['a', 'z', 'é'])
    expect(digestR6Manifest(first)).toBe(digestR6Manifest(second))
  })

  it('length framing separates concatenation-colliding field sequences', () => {
    const left = makeR6Manifest([link('a', 'bc')])
    const right = makeR6Manifest([link('ab', 'c')])

    expect(Buffer.from(encodeR6ManifestFramed(left))).not.toEqual(
      Buffer.from(encodeR6ManifestFramed(right)),
    )
    expect(digestR6Manifest(left)).not.toBe(digestR6Manifest(right))
  })

  it('binds kind, normalized mode, payload, and entry count', () => {
    const base = makeR6Manifest([file('a')])
    const executable = makeR6Manifest([{ ...file('a'), mode: 0o555 }])
    const content = makeR6Manifest([file('a', hash('b'))])
    const extra = makeR6Manifest([
      file('a'),
      { path: 'empty', kind: 'directory', mode: 0o555, payload: null },
    ])

    expect(new Set([base, executable, content, extra].map(digestR6Manifest)).size).toBe(4)
  })

  it('rejects duplicate and NFC-normalization-colliding paths', () => {
    expect(() => canonicalizeR6Entries([file('a'), file('a')])).toThrow(/Duplicate/u)
    expect(() => canonicalizeR6Entries([file('é'), file('e\u0301')])).toThrow(/Duplicate/u)
  })

  it('rejects Darwin case-fold collisions, including expansion folds', () => {
    expect(() => canonicalizeR6Entries([file('Readme'), file('README')])).toThrow(/Case-fold/u)
    expect(() => canonicalizeR6Entries([file('straße'), file('STRASSE')])).toThrow(/Case-fold/u)
  })

  it.each(['', '/absolute', '../escape', 'a/../escape', './a', 'a//b', 'a\\b'])(
    "rejects invalid manifest path '%s'",
    (path) => expect(() => makeR6Manifest([file(path)])).toThrow(/Invalid R6 relative path/u),
  )
})

describe('member-mount R6 symlink admission', () => {
  it.each([
    { path: 'dir/link', target: '../file' },
    { path: 'dir/link', target: './nested/file' },
    { path: 'link', target: '/nix/store/abc-tool/bin/tool' },
  ])('admits safe target $target', ({ path, target }) => {
    expect(() => validateR6SymlinkTarget({ path, target })).not.toThrow()
  })

  it.each([
    { path: 'link', target: '../escape' },
    { path: 'dir/link', target: '../../escape' },
    { path: 'link', target: '/etc/passwd' },
    { path: 'link', target: '/nix/store/../etc/passwd' },
  ])('rejects forbidden target $target', ({ path, target }) => {
    expect(() => validateR6SymlinkTarget({ path, target })).toThrow(/symlink/u)
  })
})

describe('owned cp-a metadata schema and path', () => {
  const metadata = {
    version: 1 as const,
    member: 'team/repo',
    lockedCommit: 'a'.repeat(40),
    sourcePathIdentity: hash('b'),
    repository: { digest: hash('c'), count: 3 },
    capabilities: { present: true, digest: hash('d'), count: 1 },
    publishedPath: '/workspace/repos/team/repo',
  }

  it('strict decoding rejects unknown metadata fields', () => {
    expect(() =>
      Schema.decodeUnknownSync(OwnedCpAMountMetadata, { onExcessProperty: 'error' })({
        ...metadata,
        proof: 'caller-controlled',
      }),
    ).toThrow(/excess/u)
  })

  it('schema decoding rejects non-canonical order and forbidden link targets', () => {
    const decode = Schema.decodeUnknownSync(R6Manifest, { onExcessProperty: 'error' })
    expect(() => decode({ version: 1, entries: [file('z'), file('a')] })).toThrow(/byte-sorted/u)
    expect(() => decode({ version: 1, entries: [link('nested/link', '../../escape')] })).toThrow(
      /escapes/u,
    )
  })

  it('uses a bijective traversal-free member filename encoding', () => {
    const names = ['a/b', 'a%2Fb', '../a', 'é', 'e\u0301'].map(encodeOwnedMountMemberFilename)
    expect(new Set(names).size).toBe(names.length)
    expect(
      names.every((name) => name.includes('/') === false && name.includes('..') === false),
    ).toBe(true)
  })

  it('places metadata outside the mount under repos/.mr/mounts', () => {
    const path = ownedCpAMountMetadataPath({ workspaceRoot: '/workspace', member: 'team/repo' })
    expect(path).toMatch(/^\/workspace\/repos\/\.mr\/mounts\/v1-[0-9a-f]+\.json$/u)
    expect(path.startsWith(metadata.publishedPath)).toBe(false)
  })
})
