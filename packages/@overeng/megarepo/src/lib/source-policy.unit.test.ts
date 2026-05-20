import { FileSystem } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
import { Effect, type Scope } from 'effect'
import { describe, expect, it } from 'vitest'

import { EffectPath, type AbsoluteDirPath } from '@overeng/effect-path'

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

const runWithContext = <A, E>(effect: Effect.Effect<A, E, NodeContext.NodeContext | Scope.Scope>) =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeContext.layer)))

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
  use: (root: AbsoluteDirPath) => Effect.Effect<A, E, NodeContext.NodeContext>,
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
            content: JSON.stringify({
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
            content: JSON.stringify({
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

  it('preserves flake dir query params in canonical source suggestions', () =>
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
            content: JSON.stringify({
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
            'github:overengineeringstudio/private-member?dir=nix/flake',
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
            content: JSON.stringify({
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
})
