import { describe, expect, it } from 'vitest'

import { supportedPnpmVersion, type PnpmLockfileV9, type TaskClosureRequest } from './model.ts'
import {
  PnpmClosureCompileError,
  compilePnpmTaskClosure,
  discoverPnpmTaskClosureInputs,
  renderPnpmClosureShards,
} from './pnpm-closure.ts'

const integrity = (character: string) => `sha512-${character.repeat(16)}`

const fixtureLockfile = (): PnpmLockfileV9 => ({
  lockfileVersion: '9.0',
  settings: { injectWorkspacePackages: true },
  packageExtensionsChecksum: 'global-policy-a',
  importers: {
    'packages/app': {
      dependencies: {
        alpha: { specifier: '1.0.0', version: '1.0.0(peer@2.0.0)' },
        local: { specifier: 'workspace:*', version: 'link:../lib' },
      },
      optionalDependencies: {
        native: { specifier: '1.0.0', version: '1.0.0' },
      },
    },
    'packages/lib': {},
  },
  packages: {
    'alpha@1.0.0': {
      resolution: { integrity: integrity('a') },
      peerDependencies: { peer: '^2' },
    },
    'native@1.0.0': {
      resolution: { integrity: integrity('n') },
      os: ['linux'],
      cpu: ['x64'],
      optional: true,
    },
    'peer@2.0.0': { resolution: { integrity: integrity('p') } },
    'unrelated@9.0.0': { resolution: { integrity: integrity('u') } },
  },
  snapshots: {
    'alpha@1.0.0(peer@2.0.0)': { dependencies: { peer: '2.0.0' } },
    'native@1.0.0': {},
    'peer@2.0.0': {},
    'unrelated@9.0.0': {},
  },
})

const baseRequest = (roots: TaskClosureRequest['roots']): TaskClosureRequest => ({
  label: '//packages/app:check',
  importerId: 'packages/app',
  mode: 'check',
  platformRole: 'exec',
  platform: { os: 'linux', cpu: 'x64', libc: 'glibc', nodeAbi: '127' },
  roots,
})

const normalizedPayloads = (lockfile: PnpmLockfileV9) =>
  Object.fromEntries(
    Object.keys(lockfile.snapshots).flatMap((depPath) => {
      const baseKey = depPath.replace(/\(.*/, '')
      const integrityValue = lockfile.packages[baseKey]?.resolution.integrity
      if (integrityValue === undefined) return []
      const patchHash = depPath.match(/\(patch_hash=([^)]+)\)/)?.[1] ?? ''
      return [
        [
          depPath,
          {
            digest: `${integrityValue}:normalized:${patchHash}`,
            materializer: { abi: 'pnpm-package-files-v1', buildPolicyDigest: `policy:${baseKey}` },
          },
        ],
      ]
    }),
  )

const compile = (args?: {
  readonly lockfile?: PnpmLockfileV9
  readonly pnpmVersion?: string
  readonly request?: TaskClosureRequest
}) => {
  const lockfile = args?.lockfile ?? fixtureLockfile()
  return compilePnpmTaskClosure({
    pnpmVersion: args?.pnpmVersion ?? supportedPnpmVersion,
    lockfile,
    request:
      args?.request ??
      baseRequest([{ alias: 'alpha', field: 'dependencies', reason: 'static import' }]),
    normalizedPayloads: normalizedPayloads(lockfile),
    workspaceLabels: { 'packages/lib': '//packages/lib:lib' },
  })
}

const errorCode = (thunk: () => unknown): string | undefined => {
  try {
    thunk()
    return undefined
  } catch (error) {
    return error instanceof PnpmClosureCompileError ? error.code : undefined
  }
}

describe('pnpm closure compiler', () => {
  it('excludes unrelated global policy and snapshots from the stable key projection', () => {
    const baseline = compile()
    const changed = structuredClone(fixtureLockfile())
    changed.packageExtensionsChecksum = 'global-policy-b'
    changed.overrides = { unrelated: '10.0.0' }
    changed.packages['unrelated@9.0.0'] = { resolution: { integrity: integrity('z') } }

    const candidate = compile({ lockfile: changed })

    expect(candidate.task.id).toBe(baseline.task.id)
    expect(candidate.task.contexts).toEqual(baseline.task.contexts)
    expect(candidate.task.contents).toEqual(baseline.task.contents)
  })

  it('identifies package content by verified bytes rather than registry mirror metadata', () => {
    const baselineLock = fixtureLockfile()
    baselineLock.packages['alpha@1.0.0']!.resolution.tarball =
      'https://registry-a.invalid/alpha.tgz'
    const mirrorLock = structuredClone(baselineLock)
    mirrorLock.packages['alpha@1.0.0']!.resolution.tarball = 'https://registry-b.invalid/alpha.tgz'

    const baseline = compile({ lockfile: baselineLock })
    const mirror = compile({ lockfile: mirrorLock })

    expect(mirror.task.id).toBe(baseline.task.id)
    expect(mirror.contents).toEqual(baseline.contents)
  })

  it('discovers exact materialization inputs without minting authoritative identities', () => {
    const lockfile = fixtureLockfile()
    const plan = discoverPnpmTaskClosureInputs({
      pnpmVersion: supportedPnpmVersion,
      lockfile,
      request: baseRequest([{ alias: 'alpha', field: 'dependencies', reason: 'plan' }]),
      workspaceLabels: { 'packages/lib': '//packages/lib:lib' },
    })

    expect(
      plan.packages.map(({ depPath, packageName, packageVersion }) => ({
        depPath,
        packageName,
        packageVersion,
      })),
    ).toEqual([
      { depPath: 'alpha@1.0.0(peer@2.0.0)', packageName: 'alpha', packageVersion: '1.0.0' },
      { depPath: 'peer@2.0.0', packageName: 'peer', packageVersion: '2.0.0' },
    ])
    expect('task' in plan).toBe(false)
  })

  it('separates package bytes from peer-context identity', () => {
    const baseline = compile()
    const changed = structuredClone(fixtureLockfile())
    changed.importers['packages/app']!.dependencies!.alpha = {
      specifier: '1.0.0',
      version: '1.0.0(peer@3.0.0)',
    }
    changed.snapshots['alpha@1.0.0(peer@3.0.0)'] = changed.snapshots['alpha@1.0.0(peer@2.0.0)']!
    delete changed.snapshots['alpha@1.0.0(peer@2.0.0)']

    const candidate = compile({ lockfile: changed })

    expect(candidate.task.contents).toEqual(baseline.task.contents)
    expect(candidate.task.contexts).not.toEqual(baseline.task.contexts)
    expect(candidate.task.id).not.toBe(baseline.task.id)
  })

  it('propagates child content changes into every parent context identity', () => {
    const baseline = compile()
    const changed = fixtureLockfile()
    changed.packages['peer@2.0.0']!.resolution.integrity = integrity('q')

    const candidate = compile({ lockfile: changed })
    const contextFor = (result: ReturnType<typeof compile>, depPath: string) =>
      Object.values(result.contexts).find((context) => context.depPath === depPath)!

    const baselineParent = contextFor(baseline, 'alpha@1.0.0(peer@2.0.0)')
    const candidateParent = contextFor(candidate, 'alpha@1.0.0(peer@2.0.0)')
    expect(candidateParent).toEqual(baselineParent)
    const baselineEdge = baseline.task.graph[baselineParent.id]!.dependencies.peer
    const candidateEdge = candidate.task.graph[candidateParent.id]!.dependencies.peer
    expect(candidateEdge).not.toBe(baselineEdge)
    expect(candidate.task.id).not.toBe(baseline.task.id)
  })

  it('represents dependency cycles without recursive hashing or coarse parent invalidation', () => {
    const lockfile = fixtureLockfile()
    lockfile.importers['packages/app']!.dependencies!.alpha = {
      specifier: '1.0.0',
      version: '1.0.0',
    }
    lockfile.snapshots['alpha@1.0.0'] = { dependencies: { peer: '2.0.0' } }
    lockfile.snapshots['peer@2.0.0'] = { dependencies: { alpha: '1.0.0' } }
    const baseline = compile({ lockfile })
    const changed = structuredClone(lockfile)
    changed.packages['peer@2.0.0']!.resolution.integrity = integrity('q')
    const candidate = compile({ lockfile: changed })

    const idsByPath = (result: ReturnType<typeof compile>) =>
      Object.fromEntries(
        Object.values(result.contexts).map((context) => [context.depPath, context.id]),
      )
    expect(idsByPath(candidate)['alpha@1.0.0']).toBe(idsByPath(baseline)['alpha@1.0.0'])
    expect(idsByPath(candidate)['peer@2.0.0']).not.toBe(idsByPath(baseline)['peer@2.0.0'])
    expect(candidate.task.id).not.toBe(baseline.task.id)
  })

  it('binds patch hashes into content, context, and task identities', () => {
    const baselineLock = fixtureLockfile()
    baselineLock.importers['packages/app']!.dependencies!.alpha = {
      specifier: '1.0.0',
      version: '1.0.0(patch_hash=aaaa)(peer@2.0.0)',
    }
    baselineLock.packages['alpha@1.0.0'] = {
      ...baselineLock.packages['alpha@1.0.0']!,
      patched: true,
    }
    baselineLock.patchedDependencies = { alpha: 'aaaa' }
    baselineLock.snapshots['alpha@1.0.0(patch_hash=aaaa)(peer@2.0.0)'] =
      baselineLock.snapshots['alpha@1.0.0(peer@2.0.0)']!
    delete baselineLock.snapshots['alpha@1.0.0(peer@2.0.0)']
    const changed = structuredClone(baselineLock)
    changed.patchedDependencies = { alpha: 'bbbb' }
    changed.importers['packages/app']!.dependencies!.alpha = {
      specifier: '1.0.0',
      version: '1.0.0(patch_hash=bbbb)(peer@2.0.0)',
    }
    changed.snapshots['alpha@1.0.0(patch_hash=bbbb)(peer@2.0.0)'] =
      changed.snapshots['alpha@1.0.0(patch_hash=aaaa)(peer@2.0.0)']!
    delete changed.snapshots['alpha@1.0.0(patch_hash=aaaa)(peer@2.0.0)']

    const baseline = compile({ lockfile: baselineLock })
    const candidate = compile({ lockfile: changed })

    expect(candidate.task.contents).not.toEqual(baseline.task.contents)
    expect(candidate.task.contexts).not.toEqual(baseline.task.contexts)
    expect(candidate.task.id).not.toBe(baseline.task.id)
  })

  it('selects optional packages per explicit platform and records deterministic omissions', () => {
    const roots = [
      { alias: 'native', field: 'optionalDependencies', reason: 'optional native tool' },
    ] as const
    const linux = compile({ request: baseRequest(roots) })
    const darwin = compile({
      request: {
        ...baseRequest(roots),
        platform: { os: 'darwin', cpu: 'arm64', nodeAbi: '127' },
      },
    })

    expect(linux.task.contexts).toHaveLength(1)
    expect(linux.task.excludedOptionalContexts).toEqual([])
    expect(darwin.task.contexts).toEqual([])
    expect(darwin.task.roots).toMatchObject([{ kind: 'excluded-optional', reason: 'os' }])
    expect(darwin.task.excludedOptionalContexts).toMatchObject([{ reason: 'os' }])
    expect(darwin.task.id).not.toBe(linux.task.id)
  })

  it('excludes an optional parent whose required child is platform-incompatible', () => {
    const lockfile = fixtureLockfile()
    lockfile.snapshots['native@1.0.0'] = { dependencies: { child: '1.0.0' } }
    lockfile.packages['child@1.0.0'] = {
      resolution: { integrity: integrity('c') },
      os: ['darwin'],
    }
    lockfile.snapshots['child@1.0.0'] = {}

    const result = compile({
      lockfile,
      request: baseRequest([
        { alias: 'native', field: 'optionalDependencies', reason: 'optional native tool' },
      ]),
    })

    expect(result.task.contexts).toEqual([])
    expect(result.task.roots).toMatchObject([{ kind: 'excluded-optional', reason: 'os' }])
    expect(result.task.excludedOptionalContexts).toEqual([
      { depPath: 'child@1.0.0', reason: 'os' },
      { depPath: 'native@1.0.0', reason: 'os' },
    ])
  })

  it('resolves importer-relative workspace links to Buck providers', () => {
    const result = compile({
      request: baseRequest([{ alias: 'local', field: 'dependencies', reason: 'workspace import' }]),
    })

    expect(result.task.contexts).toEqual([])
    expect(result.task.roots).toEqual([
      {
        kind: 'workspace',
        alias: 'local',
        field: 'dependencies',
        importerId: 'packages/lib',
        buckLabel: '//packages/lib:lib',
        pnpmReference: 'link:../lib',
      },
    ])
  })

  it('keeps declaration prose in provenance output but outside semantic task keys', () => {
    const baseline = compile()
    const candidate = compile({
      request: baseRequest([
        { alias: 'alpha', field: 'dependencies', reason: 'same dependency, revised explanation' },
      ]),
    })

    expect(candidate.task.id).toBe(baseline.task.id)
    expect(candidate.task.roots).toEqual(baseline.task.roots)
    expect(candidate.provenance).not.toEqual(baseline.provenance)
  })

  it('renders byte-identical sorted shards independent of lockfile key insertion order', () => {
    const baseline = renderPnpmClosureShards(compile())
    const reversed = structuredClone(fixtureLockfile())
    reversed.packages = Object.fromEntries(Object.entries(reversed.packages).toReversed())
    reversed.snapshots = Object.fromEntries(Object.entries(reversed.snapshots).toReversed())

    expect(renderPnpmClosureShards(compile({ lockfile: reversed }))).toEqual(baseline)
    expect(baseline.map((shard) => shard.path)).toEqual(
      baseline.map((shard) => shard.path).toSorted(),
    )
    expect(baseline.every((shard) => shard.bytes.endsWith('\n'))).toBe(true)
  })

  it('fails closed on unsupported resolver formats and incomplete inputs', () => {
    expect(errorCode(() => compile({ pnpmVersion: '11.3.0' }))).toBe('INVALID_PNPM_VERSION')
    expect(
      errorCode(() =>
        compile({
          lockfile: { ...fixtureLockfile(), lockfileVersion: '10.0' },
        }),
      ),
    ).toBe('INVALID_LOCKFILE_VERSION')

    const missingSnapshot = structuredClone(fixtureLockfile())
    delete missingSnapshot.snapshots['alpha@1.0.0(peer@2.0.0)']
    expect(errorCode(() => compile({ lockfile: missingSnapshot }))).toBe('MISSING_SNAPSHOT')

    const missingIntegrity = structuredClone(fixtureLockfile())
    missingIntegrity.packages['alpha@1.0.0'] = {
      resolution: { tarball: 'https://example.invalid/a.tgz' },
    }
    expect(errorCode(() => compile({ lockfile: missingIntegrity }))).toBe(
      'MISSING_PACKAGE_CONTENT_DIGEST',
    )

    const missingPatchMetadata = fixtureLockfile()
    missingPatchMetadata.importers['packages/app']!.dependencies!.alpha = {
      specifier: '1.0.0',
      version: '1.0.0(patch_hash=aaaa)(peer@2.0.0)',
    }
    missingPatchMetadata.packages['alpha@1.0.0']!.patched = true
    missingPatchMetadata.snapshots['alpha@1.0.0(patch_hash=aaaa)(peer@2.0.0)'] =
      missingPatchMetadata.snapshots['alpha@1.0.0(peer@2.0.0)']!
    expect(errorCode(() => compile({ lockfile: missingPatchMetadata }))).toBe(
      'PATCH_METADATA_MISSING',
    )

    expect(
      errorCode(() =>
        compile({
          request: baseRequest([
            { alias: 'alpha', field: 'dependencies', reason: 'first' },
            { alias: 'alpha', field: 'dependencies', reason: 'duplicate' },
          ]),
        }),
      ),
    ).toBe('DUPLICATE_ROOT')
    expect(
      errorCode(() =>
        compile({
          request: { ...baseRequest([]), importerId: 'packages/app/../app' },
        }),
      ),
    ).toBe('NON_CANONICAL_PATH_OR_LABEL')
    for (const importerId of ['/outside', '..']) {
      expect(
        errorCode(() =>
          compile({
            request: { ...baseRequest([]), importerId },
          }),
        ),
      ).toBe('NON_CANONICAL_PATH_OR_LABEL')
    }
    expect(
      errorCode(() =>
        compile({
          request: { ...baseRequest([]), label: '//packages//app:check' },
        }),
      ),
    ).toBe('NON_CANONICAL_PATH_OR_LABEL')
  })
})
