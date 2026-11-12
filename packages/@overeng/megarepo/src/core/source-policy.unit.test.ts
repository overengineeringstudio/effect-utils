import { describe, expect, it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { EffectPath } from '@overeng/effect-path'

import { encodeJson } from '../test-utils/mod.ts'
import { MegarepoConfig } from './config.ts'
import { LockFile } from './lock.ts'
import { checkSourcePolicy, formatSourcePolicyViolation } from './source-policy.ts'

const commit = '41e0ed18178ecef0afde18a932e24372d5d61b11'
const repo = 'example-org/example-repo'
const gitUrl = `git+https://github.com/${repo}?rev=${commit}&shallow=1`
const member = {
  url: `https://github.com/${repo}`,
  ref: 'main',
  commit,
  pinned: false,
  lockedAt: '2026-05-19T10:00:00Z',
}
const original = { type: 'git', url: member.url, rev: commit, shallow: true }
const locked = { ...original, narHash: 'sha256-example', lastModified: 1779125469 }

const check = ({
  files = {},
  allowances = [],
  members = { example: member },
  configMembers = { example: repo },
}: {
  files?: Record<string, string>
  allowances?: ReadonlyArray<string>
  members?: LockFile['members']
  configMembers?: Record<string, string>
}) =>
  checkSourcePolicy({
    megarepoRoot: EffectPath.unsafe.absoluteDir('/workspace/'),
    config: new MegarepoConfig({
      members: configMembers,
      sourcePolicy: {
        gitTransportAllowances: allowances.map((name) => ({
          _tag: 'GitHubHttps',
          member: name,
          reason: 'GitHub tarball requests fail for this repository.',
        })),
      },
    }),
    lockFile: new LockFile({ version: 1, members }),
    includeMembers: false,
  }).pipe(
    Effect.provide(
      FileSystem.layerNoop({
        exists: (path) => Effect.succeed(path.slice('/workspace/'.length) in files),
        readFileString: (path) => Effect.succeed(files[path.slice('/workspace/'.length)]!),
      }),
    ),
  )

const lockContent = (node: {
  original: Record<string, unknown>
  locked: Record<string, unknown>
}) =>
  encodeJson({ root: 'root', nodes: { root: { inputs: { example: 'example' } }, example: node } })

const declarations = (url: string) => ({
  'flake.nix': `{ inputs.example.url = "${url}"; }`,
  'devenv.yaml': `inputs:\n  example:\n    url: ${url}\n`,
})

describe('checkSourcePolicy', () => {
  it.effect('allows canonical GitHub sources with complete metadata', () =>
    Effect.gen(function* () {
      const github = { type: 'github', owner: 'example-org', repo: 'example-repo' }
      const result = yield* check({
        files: {
          ...declarations(`github:${repo}`),
          'flake.lock': lockContent({ original: github, locked: { ...locked, ...github } }),
        },
      })
      expect(result.violations).toEqual([])
    }),
  )

  it.effect('still requires complete metadata for canonical GitHub locks', () =>
    Effect.gen(function* () {
      const github = { type: 'github', owner: 'example-org', repo: 'example-repo' }
      const result = yield* check({
        files: {
          'flake.lock': lockContent({ original: github, locked: { ...github, rev: commit } }),
        },
      })
      expect(result.violations).toMatchObject([
        {
          _tag: 'IncompleteGitHubLockMetadata',
          missingFields: ['narHash', 'lastModified'],
        },
      ])
    }),
  )

  it.effect.prop(
    'allows only declared pinned HTTPS git inputs, preserving dir',
    [Schema.Boolean, Schema.Boolean, Schema.Boolean],
    ([dotGit, shallow, dir]) =>
      Effect.gen(function* () {
        const url = `git+https://github.com/${repo}${dotGit === true ? '.git' : ''}?rev=${commit}${shallow === true ? '&shallow=1' : ''}${dir === true ? '&dir=nix/flake' : ''}`
        const source = {
          type: 'git',
          url: `${member.url}${dotGit === true ? '.git' : ''}`,
          rev: commit,
          ...(shallow === true ? { shallow: true } : {}),
          ...(dir === true ? { dir: 'nix/flake' } : {}),
        }
        const content = lockContent({
          original: source,
          locked: {
            ...source,
            narHash: locked.narHash,
            lastModified: locked.lastModified,
            ...(shallow === false ? { revCount: 123 } : {}),
          },
        })
        const result = yield* check({
          allowances: ['example'],
          files: {
            ...declarations(url),
            'flake.lock': content,
            'devenv.lock': content,
          },
        })
        expect(result.violations).toEqual([])
      }),
  )

  it.effect('rejects git without an allowance in declarations and both locks', () =>
    Effect.gen(function* () {
      const content = lockContent({ original, locked })
      const result = yield* check({
        files: {
          ...declarations(gitUrl),
          'flake.lock': content,
          'devenv.lock': content,
        },
      })
      expect(result.violations.map((v) => v._tag)).toEqual(
        Array(4).fill('NonCanonicalNixInputSource'),
      )
    }),
  )

  it.effect('does not extend member A allowance to member B', () =>
    Effect.gen(function* () {
      const result = yield* check({
        allowances: ['other'],
        members: {
          example: member,
          other: { ...member, url: 'https://github.com/example-org/other' },
        },
        configMembers: { example: repo, other: 'example-org/other' },
        files: { ...declarations(gitUrl), 'flake.lock': lockContent({ original, locked }) },
      })
      expect(result.violations.map((v) => v._tag)).toEqual(
        Array(3).fill('NonCanonicalNixInputSource'),
      )
    }),
  )

  it.effect.each([
    { inputName: 'stable', rev: commit, samePin: false, expected: 0 },
    { inputName: 'next', rev: '0'.repeat(40), samePin: false, expected: 3 },
    { inputName: 'alias', rev: commit, samePin: false, expected: 0 },
    { inputName: 'alias', rev: '0'.repeat(40), samePin: false, expected: 3 },
    { inputName: 'next', rev: commit, samePin: false, expected: 3 },
    { inputName: 'stable', rev: commit, samePin: true, expected: 0 },
    { inputName: 'next', rev: commit, samePin: true, expected: 3 },
    { inputName: 'alias', rev: commit, samePin: true, expected: 3 },
  ])('isolates shared-repository members: %j', ({ inputName, rev, samePin, expected }) =>
    Effect.gen(function* () {
      const url = `git+https://github.com/${repo}?rev=${rev}&shallow=1`
      const result = yield* check({
        allowances: ['stable'],
        configMembers: { stable: repo, next: repo },
        members: {
          stable: member,
          next: {
            ...member,
            commit: samePin === true ? commit : '0'.repeat(40),
          },
        },
        files: {
          'flake.nix': `{ inputs.${inputName}.url = "${url}"; }`,
          'devenv.yaml': `inputs:\n  ${inputName}:\n    url: ${url}\n`,
          'flake.lock': encodeJson({
            root: 'root',
            nodes: {
              root: { inputs: { [inputName]: 'node' } },
              node: { original: { ...original, rev }, locked: { ...locked, rev } },
            },
          }),
        },
      })
      expect(result.violations).toHaveLength(expected)
      expect(result.violations.every((v) => v._tag === 'NonCanonicalNixInputSource')).toBe(true)
    }),
  )

  it.effect.each(['narHash', 'rev', 'lastModified'])('requires git lock metadata: %s', (field) =>
    Effect.gen(function* () {
      const incomplete: Record<string, unknown> = { ...locked }
      delete incomplete[field]
      const result = yield* check({
        allowances: ['example'],
        files: { 'flake.lock': lockContent({ original, locked: incomplete }) },
      })
      expect(result.violations).toMatchObject([
        { _tag: 'IncompleteGitHubLockMetadata', missingFields: [field] },
      ])
    }),
  )

  it.effect('requires the git lock revision to equal the member pin', () =>
    Effect.gen(function* () {
      const result = yield* check({
        allowances: ['example'],
        files: {
          'flake.lock': lockContent({ original, locked: { ...locked, rev: '0'.repeat(40) } }),
        },
      })
      expect(result.violations).toMatchObject([
        { _tag: 'GitTransportPinMismatch', expected: commit },
      ])
      expect(formatSourcePolicyViolation(result.violations[0]!)).toContain(
        `expected member pin ${commit}`,
      )
    }),
  )

  it.effect.each([
    `git+ssh://git@github.com/${repo}?rev=${commit}`,
    `git+https://github.com/${repo}?ref=main&rev=${commit}`,
    `git+https://github.com/${repo}?rev=${commit}&shallow=0`,
    `git+https://github.com/${repo}?rev=${commit}&submodules=1`,
    `git+https://github.com/${repo}?rev=${commit}&rev=${commit}`,
    `git+https://github.com/${repo}/extra?rev=${commit}`,
    `git+https://github.com/${repo}?rev=${commit}#fragment`,
    `git+https://github.com/${repo}?rev=${'0'.repeat(40)}`,
    `git+https://github.com/${repo}?shallow=1`,
    `git+https://example.com/${repo}?rev=${commit}`,
    `git+https://github.com/example-org/other?rev=${commit}`,
  ])('rejects non-allowed declaration %s', (url) =>
    Effect.gen(function* () {
      const result = yield* check({ allowances: ['example'], files: declarations(url) })
      expect(result.violations.map((v) => v._tag)).toEqual(
        Array(2).fill('NonCanonicalNixInputSource'),
      )
    }),
  )

  it.effect.each([
    { url: `ssh://git@github.com/${repo}` },
    { url: `https://example.com/${repo}` },
    { url: 'https://github.com/example-org/other' },
    { submodules: true },
    { ref: 'main' },
    { shallow: false },
  ])('rejects non-allowed git lock transport %j', (change) =>
    Effect.gen(function* () {
      const result = yield* check({
        allowances: ['example'],
        files: {
          'flake.lock': lockContent({ original, locked: { ...locked, ...change } }),
          'devenv.lock': lockContent({ original: { ...original, ...change }, locked }),
        },
      })
      expect(result.violations).toMatchObject([
        { _tag: 'NonCanonicalNixInputSource' },
        { _tag: 'NonCanonicalNixInputSource' },
      ])
    }),
  )

  it.effect('preserves dir in canonical suggestions and rejects SSH member sources', () =>
    Effect.gen(function* () {
      const result = yield* check({
        configMembers: { example: `git@github.com:${repo}.git` },
        files: declarations(`git+ssh://git@github.com/${repo}?ref=main&dir=nix/flake`),
      })
      expect(result.violations[0]?._tag).toBe('NonCanonicalGitHubMemberSource')
      expect(result.violations.slice(1)).toMatchObject([
        { expected: `github:${repo}?dir=nix/flake` },
        { expected: `github:${repo}?dir=nix/flake` },
      ])
    }),
  )
})
