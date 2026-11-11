import { NodeServices } from '@effect/platform-node'
import { Effect, type Scope } from 'effect'
import * as FileSystem from 'effect/FileSystem'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

import { encodeJson } from '../test-utils/mod.ts'
import type { MegarepoConfig } from './config.ts'
import type { LockFile } from './lock.ts'
import { checkSourcePolicy } from './source-policy.ts'

const commit = '41e0ed18178ecef0afde18a932e24372d5d61b11'

const makeConfig = (members: Record<string, string>): MegarepoConfig =>
  ({ members }) as MegarepoConfig

const makeLockFile = (): LockFile =>
  ({
    version: 1,
    members: {
      'private-member': {
        url: 'https://github.com/overengineeringstudio/private-member',
        ref: 'main',
        commit,
        pinned: false,
        lockedAt: '2026-05-19T10:00:00Z',
      },
    },
  }) as LockFile

const runWithContext = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
) => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

const writeFile = ({
  root,
  path,
  content,
}: {
  root: AbsoluteDirPath
  path: string
  content: string
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const fullPath = EffectPath.ops.join(root, EffectPath.unsafe.relativeFile(path))
    yield* fs.makeDirectory(EffectPath.ops.parent(fullPath), { recursive: true })
    yield* fs.writeFileString(fullPath, content)
  })

const withWorkspace = <A, E>(
  use: (root: AbsoluteDirPath) => Effect.Effect<A, E, NodeServices.NodeServices>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = EffectPath.unsafe.absoluteDir(`${yield* fs.makeTempDirectoryScoped()}/`)
    return yield* use(root)
  })

describe('checkSourcePolicy', () => {
  it('allows canonical GitHub source shape and complete GitHub lock metadata', () =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({
            root,
            path: 'flake.nix',
            content: `{
  inputs.private-member.url = "github:overengineeringstudio/private-member";
}`,
          })
          yield* writeFile({
            root,
            path: 'flake.lock',
            content: encodeJson({
              root: 'root',
              nodes: {
                root: { inputs: { 'private-member': 'private-member' } },
                'private-member': {
                  original: {
                    owner: 'overengineeringstudio',
                    repo: 'private-member',
                    type: 'github',
                  },
                  locked: {
                    lastModified: 1779125469,
                    narHash: 'sha256-9GjX7BCxjoimhsxW7zLHuzK+rZS1m3DtiMoo3B0xpxc=',
                    owner: 'overengineeringstudio',
                    repo: 'private-member',
                    rev: commit,
                    type: 'github',
                  },
                },
              },
            }),
          })

          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({ 'private-member': 'overengineeringstudio/private-member' }),
            lockFile: makeLockFile(),
            includeMembers: false,
          })

          expect(result.violations).toEqual([])
        }),
      ),
    ))

  it('rejects GitHub SSH member sources and Nix git inputs for megarepo members', () =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({
            root,
            path: 'flake.nix',
            content: `{
  inputs.private-member.url = "git+ssh://git@github.com/overengineeringstudio/private-member?ref=main";
}`,
          })
          yield* writeFile({
            root,
            path: 'flake.lock',
            content: encodeJson({
              root: 'root',
              nodes: {
                root: { inputs: { 'private-member': 'private-member' } },
                'private-member': {
                  original: {
                    ref: 'main',
                    type: 'git',
                    url: 'ssh://git@github.com/overengineeringstudio/private-member',
                  },
                  locked: {
                    ref: 'main',
                    rev: commit,
                    type: 'git',
                    url: 'ssh://git@github.com/overengineeringstudio/private-member',
                  },
                },
              },
            }),
          })

          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({
              'private-member': 'git@github.com:overengineeringstudio/private-member.git',
            }),
            lockFile: makeLockFile(),
            includeMembers: false,
          })

          expect(result.violations.map((violation) => violation._tag)).toEqual([
            'NonCanonicalGitHubMemberSource',
            'NonCanonicalNixInputSource',
            'NonCanonicalNixInputSource',
          ])
        }),
      ),
    ))

  it('preserves source dir suggestions and names accepted lock transports', () =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({
            root,
            path: 'flake.nix',
            content: `{
  inputs.private-member.url = "git+ssh://git@github.com/overengineeringstudio/private-member?ref=main&dir=nix/flake";
}`,
          })
          yield* writeFile({
            root,
            path: 'flake.lock',
            content: encodeJson({
              root: 'root',
              nodes: {
                root: { inputs: { 'private-member': 'private-member' } },
                'private-member': {
                  original: {
                    dir: 'nix/flake',
                    ref: 'main',
                    type: 'git',
                    url: 'ssh://git@github.com/overengineeringstudio/private-member',
                  },
                  locked: {
                    dir: 'nix/flake',
                    ref: 'main',
                    rev: commit,
                    type: 'git',
                    url: 'ssh://git@github.com/overengineeringstudio/private-member',
                  },
                },
              },
            }),
          })

          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({ 'private-member': 'overengineeringstudio/private-member' }),
            lockFile: makeLockFile(),
            includeMembers: false,
          })

          expect(
            result.violations
              .filter((violation) => violation._tag === 'NonCanonicalNixInputSource')
              .map((violation) => violation.expected),
          ).toEqual([
            'github:overengineeringstudio/private-member?dir=nix/flake',
            expect.stringContaining(
              ` or git+${makeLockFile().members['private-member']!.url}?[ref=<ref>&]rev=${commit}&shallow=1`,
            ),
          ])
        }),
      ),
    ))

  it('rejects GitHub lock nodes missing metadata required for stable Nix fetches', () =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({
            root,
            path: 'flake.lock',
            content: encodeJson({
              root: 'root',
              nodes: {
                root: { inputs: { 'private-member': 'private-member' } },
                'private-member': {
                  original: {
                    owner: 'overengineeringstudio',
                    repo: 'private-member',
                    type: 'github',
                  },
                  locked: {
                    owner: 'overengineeringstudio',
                    repo: 'private-member',
                    rev: commit,
                    type: 'github',
                  },
                },
              },
            }),
          })

          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({ 'private-member': 'overengineeringstudio/private-member' }),
            lockFile: makeLockFile(),
            includeMembers: false,
          })

          expect(result.violations).toMatchInlineSnapshot(`
            [
              {
                "_tag": "IncompleteGitHubLockMetadata",
                "file": "flake.lock",
                "inputName": "private-member",
                "missingFields": [
                  "narHash",
                  "lastModified",
                ],
                "path": "./flake.lock",
                "upstreamMember": "private-member",
              },
            ]
          `)
        }),
      ),
    ))

  const gitRepo = 'https://github.com/example-org/example-repo'
  const gitCommit = '0123456789abcdef0123456789abcdef01234567'
  const gitOriginal = { type: 'git', url: gitRepo, rev: gitCommit, shallow: true }
  const gitLocked = {
    ...gitOriginal,
    narHash: 'sha256-9GjX7BCxjoimhsxW7zLHuzK+rZS1m3DtiMoo3B0xpxc=',
    lastModified: 1779125469,
  }
  const gitLockFile = {
    ...makeLockFile(),
    members: {
      example: { ...makeLockFile().members['private-member']!, url: gitRepo, commit: gitCommit },
    },
  }

  it.each([
    `rev=${gitCommit}&shallow=1`,
    `shallow=1&ref=main&rev=${gitCommit}`,
    `ref=feature/topic&rev=${gitCommit}&shallow=1`,
  ])('allows pinned shallow GitHub HTTPS sources: %s', (query) =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({
            root,
            path: 'flake.nix',
            content: `inputs.example.url = "git+${gitRepo}?${query}";`,
          })
          for (const path of ['flake.lock', 'devenv.lock']) {
            yield* writeFile({
              root,
              path,
              content: encodeJson({
                root: 'root',
                nodes: {
                  root: { inputs: { example: 'example' } },
                  example: {
                    original: {
                      ...gitOriginal,
                      url: gitRepo
                        .toUpperCase()
                        .replace('HTTPS://GITHUB.COM', 'https://github.com'),
                    },
                    locked: gitLocked,
                  },
                },
              }),
            })
          }
          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({ example: 'example-org/example-repo' }),
            lockFile: gitLockFile,
            includeMembers: false,
          })
          expect(result.violations).toEqual([])
        }),
      ),
    ),
  )

  it.each([
    ['wrong original owner', { url: 'https://github.com/other-org/example-repo' }, {}],
    ['wrong locked repo', {}, { url: 'https://github.com/example-org/other-repo' }],
    ['short rev', {}, { rev: '0123456' }],
    ['rev mismatch', {}, { rev: 'f'.repeat(40) }],
    ['missing rev', {}, { rev: undefined }],
    [
      'non-GitHub host',
      { url: 'https://example.com/example-org/example-repo' },
      { url: 'https://example.com/example-org/example-repo' },
    ],
    ['mixed transports', {}, { type: 'github', owner: 'example-org', repo: 'example-repo' }],
    ['non-shallow', { shallow: false }, {}],
    ['unknown parameter', { submodules: true }, {}],
  ])('rejects inconsistent git lock sources: %s', (_name, original, locked) =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({
            root,
            path: 'flake.lock',
            content: encodeJson({
              root: 'root',
              nodes: {
                root: { inputs: { example: 'example' } },
                example: {
                  original: { ...gitOriginal, ...original },
                  locked: { ...gitLocked, ...locked },
                },
              },
            }),
          })
          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({ example: 'example-org/example-repo' }),
            lockFile: gitLockFile,
            includeMembers: false,
          })
          expect(result.violations).toMatchObject([
            {
              _tag: 'NonCanonicalNixInputSource',
              upstreamMember: 'example',
              expected: expect.stringContaining('git+https://github.com/example-org/example-repo'),
            },
          ])
        }),
      ),
    ),
  )

  it.each([
    `git+${gitRepo}?rev=0123456&shallow=1`,
    `git+${gitRepo}?rev=${'f'.repeat(40)}&shallow=1`,
    `git+${gitRepo}?rev=${gitCommit}`,
    `git+${gitRepo}?rev=${gitCommit}&shallow=1&submodules=1`,
    `git+${gitRepo}?rev=${gitCommit}&rev=${gitCommit}&shallow=1`,
    `git+https://example.com/example-org/example-repo?rev=${gitCommit}&shallow=1`,
    `git+https://github.com/other-org/example-repo?rev=${gitCommit}&shallow=1`,
  ])('rejects unsupported git source URL: %s', (url) =>
    runWithContext(
      withWorkspace((root) =>
        Effect.gen(function* () {
          yield* writeFile({ root, path: 'flake.nix', content: `inputs.example.url = "${url}";` })
          const result = yield* checkSourcePolicy({
            megarepoRoot: root,
            config: makeConfig({ example: 'example-org/example-repo' }),
            lockFile: gitLockFile,
            includeMembers: false,
          })
          expect(result.violations).toMatchObject([{ _tag: 'NonCanonicalNixInputSource' }])
        }),
      ),
    ),
  )
})
