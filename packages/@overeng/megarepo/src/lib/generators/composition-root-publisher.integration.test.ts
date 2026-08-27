import { execFile } from 'node:child_process'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'
import { promisify } from 'node:util'

import { describe, it } from '@effect/vitest'
import { Effect, Fiber } from 'effect'
import { expect } from 'vitest'

import { CompositionGeneratorConfig, EffectPath } from '../config.ts'
import {
  publishCompositionRoot,
  teardownCompositionRoot,
  type CompositionRootPublicationError,
  type CompositionRootPublicationRuntime,
  type PublishCompositionRootOptions,
} from './composition-root-publisher.ts'
import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  COMPOSITION_GENERATION_MANIFEST_PATH,
  encodeBuckMemberManifestJson,
  generateCompositionRoot,
  type BuckMemberManifest,
} from './composition-root.ts'

const execFilePromise = promisify(execFile)
const generatedPaths = [
  '.buckroot',
  '.megarepo/bin/buck2',
  COMPOSITION_GENERATION_MANIFEST_PATH,
  'BUCK',
  'none/BUCK',
  'toolchains/BUCK',
  '.buckconfig',
] as const

const memberManifest = ({
  memberKey,
  cell = memberKey,
  mount = `repos/${memberKey}`,
}: {
  readonly memberKey: string
  readonly cell?: string
  readonly mount?: string
}): BuckMemberManifest => ({
  schemaVersion: 1,
  cell,
  mount,
  projectIgnore: [],
  distOverlays: [],
  capabilities: [],
})

interface Fixture {
  readonly root: string
  readonly workspaceRoot: ReturnType<typeof EffectPath.unsafe.absoluteDir>
  readonly buckExecutable: string
}

const makeFixture = ({
  members = ['alpha', 'beta'],
  manifests = {},
}: {
  readonly members?: ReadonlyArray<string>
  readonly manifests?: Readonly<Record<string, BuckMemberManifest | string>>
} = {}) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const root = await mkdtemp(NodePath.join(tmpdir(), 'megarepo-composition-publisher-'))
      await mkdir(NodePath.join(root, 'repos'), { recursive: true })
      for (const member of members) {
        const memberRoot = NodePath.join(root, 'repos', member)
        await mkdir(memberRoot, { recursive: true })
        const manifest = manifests[member] ?? memberManifest({ memberKey: member })
        await writeFile(
          NodePath.join(memberRoot, BUCK_MEMBER_MANIFEST_FILENAME),
          typeof manifest === 'string' ? manifest : encodeBuckMemberManifestJson(manifest),
        )
      }
      const buckExecutable = NodePath.join(root, 'fake-buck2')
      await writeFile(buckExecutable, '#!/bin/sh\nprintf "%s\\n" "$@"\n')
      await chmod(buckExecutable, 0o755)
      return {
        root,
        workspaceRoot: EffectPath.unsafe.absoluteDir(`${root}/`),
        buckExecutable,
      }
    }),
    ({ root }) => Effect.promise(() => rm(root, { recursive: true, force: true })),
  )

const compositionConfig = (platformHub = 'alpha', isolationDir = 'megarepo') =>
  new CompositionGeneratorConfig({ platformHub, isolationDir })

const runtime = (
  overrides: Partial<CompositionRootPublicationRuntime> = {},
): CompositionRootPublicationRuntime => ({
  assertCapabilityProjection: async () => undefined,
  ...overrides,
})

const optionsFor = ({
  fixture,
  memberKeys = ['alpha', 'beta'],
  ownedMemberKey = 'alpha',
  platformHub = 'alpha',
  isolationDir = 'megarepo',
  cacheValue,
  publicationRuntime = runtime(),
  lockToken = 'test-token',
  recoverToken,
}: {
  readonly fixture: Fixture
  readonly memberKeys?: ReadonlyArray<string>
  readonly ownedMemberKey?: string
  readonly platformHub?: string
  readonly isolationDir?: string
  readonly cacheValue?: string
  readonly publicationRuntime?: CompositionRootPublicationRuntime
  readonly lockToken?: string
  readonly recoverToken?: string
}): PublishCompositionRootOptions => ({
  workspaceRoot: fixture.workspaceRoot,
  configMemberKeys: memberKeys,
  ownedMemberKey,
  compositionConfig: compositionConfig(platformHub, isolationDir),
  resolvedBuckExecutable: fixture.buckExecutable,
  cacheSections:
    cacheValue === undefined
      ? []
      : [{ section: 'buck2_re_client', entries: [{ key: 'address', value: cacheValue }] }],
  lock: {
    owner: 'publisher-test',
    token: lockToken,
    ...(recoverToken === undefined ? {} : { recoverToken }),
  },
  runtime: publicationRuntime,
})

const readGenerated = (fixture: Fixture, relativePath: string): Effect.Effect<Buffer> =>
  Effect.promise(() => readFile(NodePath.join(fixture.root, relativePath)))

const exists = (path: string): Effect.Effect<boolean> =>
  Effect.promise(() =>
    lstat(path).then(
      () => true,
      (cause: unknown) => {
        if (
          typeof cause === 'object' &&
          cause !== null &&
          'code' in cause &&
          cause.code === 'ENOENT'
        ) {
          return false
        }
        throw cause
      },
    ),
  )

const failureReason = <A>(
  effect: Effect.Effect<A, CompositionRootPublicationError>,
): Effect.Effect<CompositionRootPublicationError> =>
  Effect.result(effect).pipe(
    Effect.flatMap((result) =>
      result._tag === 'Failure'
        ? Effect.succeed(result.failure)
        : Effect.die('Expected composition publication failure'),
    ),
  )

describe('composition root publisher', () => {
  it.effect('publishes the pure plan with .buckconfig as the final authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const published: string[] = []
        const result = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            publicationRuntime: runtime({
              afterPublishedFile: async (path) => {
                published.push(path)
              },
            }),
          }),
        )

        expect(result.changedPaths).toEqual(published)
        expect(published.at(-1)).toBe('.buckconfig')
        for (const relativePath of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, relativePath))).toBe(true)
        }
        expect(result.memberManifests.map(({ memberKey }) => memberKey)).toEqual(['alpha', 'beta'])
      }),
    ),
  )

  it.effect('preserves bytes, modes, and mtimes on an idempotent repeat', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const options = optionsFor({ fixture })
        yield* publishCompositionRoot(options)
        const before = new Map(
          yield* Effect.promise(() =>
            Promise.all(
              generatedPaths.map(async (path) => {
                const info = await stat(NodePath.join(fixture.root, path))
                return [path, { mtimeMs: info.mtimeMs, mode: info.mode & 0o777 }] as const
              }),
            ),
          ),
        )
        const repeated = yield* publishCompositionRoot(options)
        expect(repeated.changedPaths).toEqual([])
        for (const path of generatedPaths) {
          const info = yield* Effect.promise(() => stat(NodePath.join(fixture.root, path)))
          expect(info.mtimeMs).toBe(before.get(path)?.mtimeMs)
          expect(info.mode & 0o777).toBe(before.get(path)?.mode)
        }
      }),
    ),
  )

  it.effect('canonicalizes config member permutation without republishing', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha', 'beta'] }))
        const before = yield* Effect.promise(() => stat(NodePath.join(fixture.root, '.buckconfig')))
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['beta', 'alpha'] }),
        )
        const after = yield* Effect.promise(() => stat(NodePath.join(fixture.root, '.buckconfig')))
        expect(result.changedPaths).toEqual([])
        expect(after.mtimeMs).toBe(before.mtimeMs)
      }),
    ),
  )

  it.effect('strictly decodes and carries member dist overlays without publishing them yet', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const alpha = {
          ...memberManifest({ memberKey: 'alpha' }),
          distOverlays: [{ target: '//packages/app:dist', destination: 'dist/app' }],
        }
        const fixture = yield* makeFixture({
          members: ['alpha'],
          manifests: { alpha },
        })
        const result = yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'overlay-token' }),
        )
        expect(result.memberManifests[0]?.manifest.distOverlays).toEqual(alpha.distOverlays)
        const config = (yield* readGenerated(fixture, '.buckconfig')).toString()
        expect(config).not.toContain('//packages/app:dist')
        expect(config).not.toContain('dist/app')
        expect(yield* exists(NodePath.join(fixture.root, 'repos/alpha/dist/app'))).toBe(false)
      }),
    ),
  )

  it.effect('strictly rejects missing and invalid member manifests', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const missing = yield* makeFixture({ members: ['alpha'] })
        yield* Effect.promise(() =>
          rm(NodePath.join(missing.root, 'repos/alpha', BUCK_MEMBER_MANIFEST_FILENAME)),
        )
        expect(
          (yield* failureReason(
            publishCompositionRoot(optionsFor({ fixture: missing, memberKeys: ['alpha'] })),
          )).reason,
        ).toBe('InvalidMemberManifest')

        const invalid = yield* makeFixture({
          members: ['alpha'],
          manifests: { alpha: '{"schemaVersion":1,"unknown":true}\n' },
        })
        expect(
          (yield* failureReason(
            publishCompositionRoot(optionsFor({ fixture: invalid, memberKeys: ['alpha'] })),
          )).reason,
        ).toBe('InvalidMemberManifest')
      }),
    ),
  )

  it.effect('rejects mount disagreement and a hub outside the configured members', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const mismatch = yield* makeFixture({
          members: ['alpha'],
          manifests: { alpha: memberManifest({ memberKey: 'alpha', mount: 'repos/other' }) },
        })
        expect(
          (yield* failureReason(
            publishCompositionRoot(optionsFor({ fixture: mismatch, memberKeys: ['alpha'] })),
          )).reason,
        ).toBe('InvalidInput')

        const fixture = yield* makeFixture({ members: ['alpha'] })
        expect(
          (yield* failureReason(
            publishCompositionRoot(
              optionsFor({ fixture, memberKeys: ['alpha'], platformHub: 'beta' }),
            ),
          )).reason,
        ).toBe('InvalidInput')
      }),
    ),
  )

  it.effect('requires the capability projection assertion for every member including owned', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const checked: string[] = []
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              publicationRuntime: runtime({
                assertCapabilityProjection: async ({ memberKey, owned }) => {
                  checked.push(`${memberKey}:${owned}`)
                  if (memberKey === 'beta') throw new Error('projection check failed')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('CapabilityPrerequisiteFailure')
        expect(checked).toEqual(['alpha:true', 'beta:false'])
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)
      }),
    ),
  )

  it.effect('forward-recovers every durable candidate fault without exposing first authority', () =>
    Effect.scoped(
      Effect.gen(function* () {
        for (const faultPath of generatedPaths) {
          const fixture = yield* makeFixture()
          const error = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                publicationRuntime: runtime({
                  afterCandidateFile: async (path) => {
                    if (path === faultPath) throw new Error(`fault:${path}`)
                  },
                }),
              }),
            ),
          )
          expect(error.reason).toBe('IoFailure')
          expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)
          yield* publishCompositionRoot(optionsFor({ fixture }))
          expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(true)
        }
      }),
    ),
  )

  it.effect('rolls back and cleans first-create files after an installed-file failure', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'first-create-rollback',
              publicationRuntime: runtime({
                afterPublishedFile: async (path) => {
                  if (path === 'BUCK') throw new Error('fail after install')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('IoFailure')
        for (const path of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
        }
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('preserves previous root authority when an update candidate fails', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'old:1234' }))
        const oldConfig = yield* readGenerated(fixture, '.buckconfig')
        const oldManifest = yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)
        yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              publicationRuntime: runtime({
                afterCandidateFile: async (path) => {
                  if (path === '.buckconfig') throw new Error('stop before authority')
                },
              }),
            }),
          ),
        )
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(oldConfig)
        expect(yield* readGenerated(fixture, COMPOSITION_GENERATION_MANIFEST_PATH)).toEqual(
          oldManifest,
        )
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'new:5678' }))
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain('new:5678')
      }),
    ),
  )

  it.effect('refuses foreign replacement bytes and modes before any mutation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture }))
        const configBefore = yield* readGenerated(fixture, '.buckconfig')
        yield* Effect.promise(() => writeFile(NodePath.join(fixture.root, 'BUCK'), 'foreign\n'))
        const error = yield* failureReason(publishCompositionRoot(optionsFor({ fixture })))
        expect(error.reason).toBe('ForeignPath')
        expect((yield* readGenerated(fixture, 'BUCK')).toString()).toBe('foreign\n')
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(configBefore)

        yield* Effect.promise(async () => {
          await writeFile(NodePath.join(fixture.root, 'BUCK'), '')
          await chmod(NodePath.join(fixture.root, 'BUCK'), 0o755)
        })
        expect((yield* failureReason(publishCompositionRoot(optionsFor({ fixture })))).reason).toBe(
          'ForeignPath',
        )
      }),
    ),
  )

  it.effect('refuses a foreign replacement injected at the candidate boundary', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture, cacheValue: 'old:1234' }))
        const configPath = NodePath.join(fixture.root, '.buckconfig')
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              publicationRuntime: runtime({
                afterCandidateFile: async (path) => {
                  if (path === '.buckconfig') await writeFile(configPath, 'foreign authority\n')
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toBe(
          'foreign authority\n',
        )
      }),
    ),
  )

  it.effect('refuses invalid or missing ownership manifests once authority exists', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalid = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture: invalid }))
        yield* Effect.promise(() =>
          writeFile(NodePath.join(invalid.root, COMPOSITION_GENERATION_MANIFEST_PATH), '{}\n'),
        )
        expect(
          (yield* failureReason(publishCompositionRoot(optionsFor({ fixture: invalid })))).reason,
        ).toBe('InvalidGenerationManifest')

        const missing = yield* makeFixture()
        yield* publishCompositionRoot(optionsFor({ fixture: missing }))
        yield* Effect.promise(() =>
          rm(NodePath.join(missing.root, COMPOSITION_GENERATION_MANIFEST_PATH)),
        )
        expect(
          (yield* failureReason(publishCompositionRoot(optionsFor({ fixture: missing })))).reason,
        ).toBe('InvalidGenerationManifest')
      }),
    ),
  )

  it.effect('adopts only exact first-create partial constants', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const pure = generateCompositionRoot({
          schemaVersion: 1,
          members: [{ memberKey: 'alpha', manifest: memberManifest({ memberKey: 'alpha' }) }],
          platformHubCell: 'alpha',
          resolvedBuckExecutable: fixture.buckExecutable,
        })
        const rootBuck = pure.files.find((file) => file.path === 'BUCK')!
        yield* Effect.promise(() => writeFile(NodePath.join(fixture.root, 'BUCK'), rootBuck.bytes))
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(true)
      }),
    ),
  )

  it.effect('publishes an atomic executable wrapper that fixes and protects isolation', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], isolationDir: 'fleet-buck' }),
        )
        const wrapper = NodePath.join(fixture.root, '.megarepo/bin/buck2')
        const info = yield* Effect.promise(() => stat(wrapper))
        expect(info.mode & 0o777).toBe(0o755)
        const success = yield* Effect.promise(() =>
          execFilePromise(wrapper, ['build', '//alpha:all']),
        )
        expect(success.stdout).toBe('--isolation-dir\nfleet-buck\nbuild\n//alpha:all\n')
        const rejected = yield* Effect.promise(() =>
          execFilePromise(wrapper, ['--isolation-dir=other', 'build']).then(
            () => ({ code: 0, stderr: '' }),
            (cause: unknown) => {
              const error = cause as { readonly code?: number; readonly stderr?: string }
              return { code: error.code, stderr: error.stderr ?? '' }
            },
          ),
        )
        expect(rejected.code).toBe(64)
        expect(rejected.stderr).toContain('--isolation-dir is fixed to fleet-buck')
      }),
    ),
  )

  it.effect('refuses a cooperating concurrent publisher while the exclusive lock is live', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        let signalEntered: () => void = () => undefined
        let releaseFirst: () => void = () => undefined
        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve
        })
        const gate = new Promise<void>((resolve) => {
          releaseFirst = resolve
        })
        const first = yield* Effect.forkChild(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'live-token',
              publicationRuntime: runtime({
                afterCandidateFile: async (path) => {
                  if (path !== '.buckconfig') return
                  signalEntered()
                  await gate
                },
              }),
            }),
          ),
        )
        yield* Effect.promise(() => entered)
        const second = yield* failureReason(
          publishCompositionRoot(optionsFor({ fixture, lockToken: 'concurrent-token' })),
        )
        expect(second.reason).toBe('LockHeld')
        releaseFirst()
        yield* Fiber.join(first)
      }),
    ),
  )

  it.effect(
    'serializes publication and requires the exact stale-lock token for changed-input recovery',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture()
          const fault = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                cacheValue: 'old:1234',
                lockToken: 'stale-token',
                publicationRuntime: runtime({
                  simulateProcessFaultAfterCandidate: (path) => path === '.buckconfig',
                }),
              }),
            ),
          )
          expect(fault.reason).toBe('SimulatedProcessFault')
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
          ).toBe(true)
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(true)
          expect(
            (yield* failureReason(
              publishCompositionRoot(
                optionsFor({ fixture, cacheValue: 'new:5678', lockToken: 'new-token' }),
              ),
            )).reason,
          ).toBe('LockHeld')
          expect(
            (yield* failureReason(
              publishCompositionRoot(
                optionsFor({
                  fixture,
                  cacheValue: 'new:5678',
                  lockToken: 'new-token',
                  recoverToken: 'wrong-token',
                }),
              ),
            )).reason,
          ).toBe('LockHeld')

          yield* publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              lockToken: 'new-token',
              recoverToken: 'stale-token',
            }),
          )
          const config = (yield* readGenerated(fixture, '.buckconfig')).toString()
          expect(config).toContain('new:5678')
          expect(config).not.toContain('old:1234')
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
          ).toBe(false)
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(false)
          expect(
            yield* exists(
              NodePath.join(fixture.root, '.megarepo/composition-publication/stale-token'),
            ),
          ).toBe(false)
        }),
      ),
  )

  it.effect(
    'recovers observed backups after a process fault and then publishes changed inputs',
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = yield* makeFixture()
          yield* publishCompositionRoot(
            optionsFor({ fixture, cacheValue: 'old:1234', lockToken: 'initial-token' }),
          )
          const fault = yield* failureReason(
            publishCompositionRoot(
              optionsFor({
                fixture,
                cacheValue: 'middle:5678',
                lockToken: 'backup-token',
                publicationRuntime: runtime({
                  simulateProcessFaultAfterPublishedFile: (path) =>
                    path === COMPOSITION_GENERATION_MANIFEST_PATH,
                }),
              }),
            ),
          )
          expect(fault.reason).toBe('SimulatedProcessFault')
          expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(false)

          yield* publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'final:9012',
              lockToken: 'recovered-token',
              recoverToken: 'backup-token',
            }),
          )
          const config = (yield* readGenerated(fixture, '.buckconfig')).toString()
          expect(config).toContain('final:9012')
          expect(config).not.toContain('middle:5678')
          expect(
            yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
          ).toBe(false)
        }),
      ),
  )

  it.effect('rolls forward a fully observed config-last commit after process death', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        const fault = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'committed:1234',
              lockToken: 'commit-token',
              publicationRuntime: runtime({
                simulateProcessFaultAfterPublishedFile: (path) => path === '.buckconfig',
              }),
            }),
          ),
        )
        expect(fault.reason).toBe('SimulatedProcessFault')
        expect((yield* readGenerated(fixture, '.buckconfig')).toString()).toContain(
          'committed:1234',
        )
        const recovered = yield* publishCompositionRoot(
          optionsFor({
            fixture,
            cacheValue: 'committed:1234',
            lockToken: 'after-commit-token',
            recoverToken: 'commit-token',
          }),
        )
        expect(recovered.changedPaths).toEqual([])
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('refuses a foreign candidate during exact-token recovery', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'foreign-candidate-token',
              publicationRuntime: runtime({
                simulateProcessFaultAfterCandidate: (path) => path === '.buckconfig',
              }),
            }),
          ),
        )
        const candidate = NodePath.join(
          fixture.root,
          '.megarepo/composition-publication/foreign-candidate-token/candidates',
          Buffer.from('.buckconfig').toString('hex'),
        )
        yield* Effect.promise(async () => {
          await unlink(candidate)
          await writeFile(candidate, 'foreign candidate\n')
          await chmod(candidate, 0o644)
        })
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              lockToken: 'replacement-token',
              recoverToken: 'foreign-candidate-token',
            }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        expect(yield* Effect.promise(() => readFile(candidate, 'utf8'))).toBe('foreign candidate\n')
      }),
    ),
  )

  it.effect('revalidates each destination identity and restores prior authority last', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture()
        yield* publishCompositionRoot(
          optionsFor({ fixture, cacheValue: 'old:1234', lockToken: 'initial-token' }),
        )
        const manifestPath = NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)
        const oldManifest = yield* Effect.promise(() => readFile(manifestPath))
        const oldConfig = yield* readGenerated(fixture, '.buckconfig')
        const oldIdentity = yield* Effect.promise(() => lstat(manifestPath))
        const error = yield* failureReason(
          publishCompositionRoot(
            optionsFor({
              fixture,
              cacheValue: 'new:5678',
              lockToken: 'race-token',
              publicationRuntime: runtime({
                beforeInstallFile: async (path) => {
                  if (path !== COMPOSITION_GENERATION_MANIFEST_PATH) return
                  const replacementPath = `${manifestPath}.foreign`
                  await writeFile(replacementPath, oldManifest)
                  await chmod(replacementPath, 0o644)
                  await rename(replacementPath, manifestPath)
                },
              }),
            }),
          ),
        )
        expect(error.reason).toBe('ForeignPath')
        const replacementIdentity = yield* Effect.promise(() => lstat(manifestPath))
        expect(replacementIdentity.ino).not.toBe(oldIdentity.ino)
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(oldConfig)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publication.json')),
        ).toBe(false)
        expect(
          yield* exists(NodePath.join(fixture.root, '.megarepo/composition-publisher.lock.json')),
        ).toBe(false)
      }),
    ),
  )

  it.effect('teardown removes only verified generated files and empty owned directories', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        const ownedConfig = NodePath.join(fixture.root, 'repos/alpha/megarepo.kdl')
        yield* Effect.promise(async () => {
          await writeFile(ownedConfig, 'members { alpha "owner/alpha" }\n')
          await symlink('repos/alpha/megarepo.kdl', NodePath.join(fixture.root, 'megarepo.kdl'))
          await mkdir(NodePath.join(fixture.root, 'buck-out'))
          await writeFile(NodePath.join(fixture.root, 'buck-out/keep'), 'keep\n')
        })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        const result = yield* teardownCompositionRoot({
          workspaceRoot: fixture.workspaceRoot,
          lock: { owner: 'publisher-test', token: 'teardown-token' },
        })
        expect(result.removedPaths.toSorted()).toEqual([...generatedPaths].toSorted())
        for (const path of generatedPaths) {
          expect(yield* exists(NodePath.join(fixture.root, path))).toBe(false)
        }
        expect(yield* exists(NodePath.join(fixture.root, 'repos/alpha'))).toBe(true)
        expect(yield* exists(NodePath.join(fixture.root, 'megarepo.kdl'))).toBe(true)
        expect(yield* exists(NodePath.join(fixture.root, 'buck-out/keep'))).toBe(true)
        expect(yield* exists(ownedConfig)).toBe(true)
      }),
    ),
  )

  it.effect('teardown revalidates no-follow identity immediately before unlink', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(
          optionsFor({ fixture, memberKeys: ['alpha'], lockToken: 'publish-token' }),
        )
        const configPath = NodePath.join(fixture.root, '.buckconfig')
        const configBytes = yield* Effect.promise(() => readFile(configPath))
        const before = yield* Effect.promise(() => lstat(configPath))
        const error = yield* failureReason(
          teardownCompositionRoot({
            workspaceRoot: fixture.workspaceRoot,
            lock: { owner: 'publisher-test', token: 'teardown-race-token' },
            beforeRemoveFile: async (path) => {
              if (path !== '.buckconfig') return
              const replacementPath = `${configPath}.foreign`
              await writeFile(replacementPath, configBytes)
              await chmod(replacementPath, 0o644)
              await rename(replacementPath, configPath)
            },
          }),
        )
        expect(error.reason).toBe('ForeignPath')
        const replacement = yield* Effect.promise(() => lstat(configPath))
        expect(replacement.ino).not.toBe(before.ino)
        expect(yield* readGenerated(fixture, '.buckconfig')).toEqual(configBytes)
        expect(
          yield* exists(NodePath.join(fixture.root, COMPOSITION_GENERATION_MANIFEST_PATH)),
        ).toBe(true)
      }),
    ),
  )

  it.effect('teardown validates all ownership before removing anything', () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* makeFixture({ members: ['alpha'] })
        yield* publishCompositionRoot(optionsFor({ fixture, memberKeys: ['alpha'] }))
        yield* Effect.promise(() =>
          writeFile(NodePath.join(fixture.root, 'toolchains/BUCK'), 'foreign\n'),
        )
        const error = yield* failureReason(
          teardownCompositionRoot({
            workspaceRoot: fixture.workspaceRoot,
            lock: { owner: 'publisher-test', token: 'teardown-token' },
          }),
        )
        expect(error.reason).toBe('ForeignPath')
        expect(yield* exists(NodePath.join(fixture.root, '.buckconfig'))).toBe(true)
        expect((yield* readGenerated(fixture, 'toolchains/BUCK')).toString()).toBe('foreign\n')
      }),
    ),
  )
})
