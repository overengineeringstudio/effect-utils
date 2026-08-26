import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import {
  canonicalizePnpmPrunedLock,
  pnpmInstallDescriptorSchema,
  pnpmWorkspacePlaceholder,
  preparePnpmInstallDescriptor,
  rehydratePnpmWorkspacePlaceholder,
  resolvePnpmInstallArgv,
} from './pnpm-install-descriptor.ts'

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/pnpm-install-descriptor/${name}`, import.meta.url)), 'utf8')

const prepareFixture = () =>
  preparePnpmInstallDescriptor({
    rawLockfile: fixture('raw-path-a.yaml'),
    stagePrefix: '/fixed/a',
    packageName: 'app',
    workspaceManifest: 'patchedDependencies:\n  patched@1.0.0: patches/p.patch\n',
    packageManifests: new Map([
      [
        'packages/app/package.json',
        '{"name":"app","dependencies":{"@acme/lib":"workspace:*"}}',
      ],
      [
        'packages/acme/lib/package.json',
        '{"name":"@acme/lib","peerDependencies":{"react":"^18"}}',
      ],
    ]),
    patches: new Map([['patches/p.patch', 'patch bytes\n']]),
  })

describe('canonical pnpm pruned lock', () => {
  it('canonicalizes two stage paths and peer-range variants to exact identical bytes', () => {
    const canonicalA = canonicalizePnpmPrunedLock({
      rawLockfile: fixture('raw-path-a.yaml'),
      stagePrefix: '/fixed/a',
    })
    const canonicalB = canonicalizePnpmPrunedLock({
      rawLockfile: fixture('raw-path-b.yaml'),
      stagePrefix: '/fixed/a-much-longer-b',
    })

    expect(canonicalA).toBe(fixture('canonical.golden.yaml'))
    expect(canonicalB).toBe(canonicalA)
    expect(canonicalA).toContain(pnpmWorkspacePlaceholder)
    expect(canonicalA).not.toContain('/fixed/')
    expect(canonicalizePnpmPrunedLock({ rawLockfile: canonicalA, stagePrefix: '/fixed/a' })).toBe(
      canonicalA,
    )
  })

  it('removes only packages.*.peerDependencies and retains contextual snapshots and metadata', () => {
    const canonical = Reflect.get(Reflect.get(globalThis, 'Bun'), 'YAML').parse(
      fixture('canonical.golden.yaml'),
    ) as Record<string, unknown>
    const packages = canonical.packages as Record<string, Record<string, unknown>>
    const snapshots = canonical.snapshots as Record<string, Record<string, unknown>>
    const packageKey = `@acme/lib@${pnpmWorkspacePlaceholder}/packages/acme/lib`
    const snapshotKey = `${packageKey}(hash)(react@19.0.0)`

    expect(packages[packageKey]?.peerDependencies).toBeUndefined()
    expect(packages[packageKey]?.peerDependenciesMeta).toEqual({ react: { optional: true } })
    expect(snapshots[snapshotKey]).toEqual({
      dependencies: { react: '19.0.0' },
      peerDependencies: { react: '19.0.0' },
    })
  })

  it('fails closed on malformed shape and stage-prefix key collisions', () => {
    expect(() =>
      canonicalizePnpmPrunedLock({ rawLockfile: 'lockfileVersion: 9\n', stagePrefix: '/fixed/a' }),
    ).toThrow('pruned lockfile.importers must be a mapping')

    const collision = fixture('raw-path-a.yaml').replace(
      '  react@19.0.0:\n    resolution:',
      `  '${pnpmWorkspacePlaceholder}': {}\n  '/fixed/a': {}\n  react@19.0.0:\n    resolution:`,
    )
    expect(() => canonicalizePnpmPrunedLock({ rawLockfile: collision, stagePrefix: '/fixed/a' })).toThrow(
      'duplicate mapping key',
    )

    const residual = fixture('raw-path-a.yaml').replace(
      'version: file:/fixed/a/packages/acme/lib(hash)(react@19.0.0)',
      'version: file:/unresolved/root/packages/acme/lib(hash)(react@19.0.0)',
    )
    expect(() => canonicalizePnpmPrunedLock({ rawLockfile: residual, stagePrefix: '/fixed/a' })).toThrow(
      'unresolved absolute file reference',
    )
  })
})

describe('pnpm frozen-install descriptor', () => {
  it('emits the exact schema, aligned manifest, replay policy, and relevant files', () => {
    const prepared = prepareFixture()

    expect(prepared.descriptor.schema).toBe(pnpmInstallDescriptorSchema)
    expect(`${JSON.stringify(prepared.descriptor, null, 2)}\n`).toBe(fixture('descriptor.golden.json'))
    expect(prepared.packageManifest).toBe(fixture('package.golden.json'))
    expect(prepared.workspaceManifest).toBe(fixture('workspace.golden.yaml'))
    expect([...prepared.workspacePackageManifests]).toEqual([
      [
        'packages/acme/lib/package.json',
        '{\n  "name": "@acme/lib",\n  "peerDependencies": {\n    "react": "^18"\n  }\n}\n',
      ],
    ])
    expect([...prepared.patches]).toEqual([['patches/p.patch', 'patch bytes\n']])
  })

  it('fixes and resolves the exact frozen Stage-2 pnpm argv', () => {
    const descriptor = prepareFixture().descriptor
    expect(resolvePnpmInstallArgv({ descriptor, installRoot: '/fixed/install', storeDir: '/store' })).toEqual([
      '--dir',
      '/fixed/install',
      '--store-dir',
      '/store',
      'install',
      '--prod=false',
      '--ignore-scripts',
      '--offline',
      '--frozen-lockfile',
    ])
    expect(rehydratePnpmWorkspacePlaceholder(fixture('canonical.golden.yaml'), '/fixed/install')).toContain(
      'file:/fixed/install/packages/acme/lib',
    )
  })

  it('fails on unresolved file and patch references', () => {
    const base = {
      rawLockfile: fixture('raw-path-a.yaml'),
      stagePrefix: '/fixed/a',
      packageName: 'app',
      workspaceManifest: 'patchedDependencies:\n  patched@1.0.0: patches/p.patch\n',
      packageManifests: new Map([
        ['packages/app/package.json', '{"name":"app"}'],
      ]),
      patches: new Map([['patches/p.patch', 'patch bytes\n']]),
    }
    expect(() => preparePnpmInstallDescriptor(base)).toThrow('unresolved file reference')
    expect(() =>
      preparePnpmInstallDescriptor({
        ...base,
        packageManifests: new Map([
          ['packages/app/package.json', '{"name":"app"}'],
          ['packages/acme/lib/package.json', '{"name":"@acme/lib"}'],
        ]),
        patches: new Map(),
      }),
    ).toThrow('unresolved patch path')
  })
})
