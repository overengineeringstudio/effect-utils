import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import { nixGraftedStoreOverridePackages } from '../../genie/native-dependency-policy.ts'
import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
} from './pnpm-lock.ts'
import { renderPnpmPlatformGatedPackages, renderPnpmStoreBuck } from './pnpm-store-buck.ts'
import {
  computeStoreSccs,
  makePnpmStoreProjection,
  packageAllowed,
  platformGatedPackageNames,
  platformVaryingEntries,
  pnpmPlatforms,
  portablePnpmPlatform,
  workspaceKey,
} from './pnpm-store.ts'

const archive = new TextEncoder().encode('archive bytes')
const archiveIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`

const workspaceText = `packages:
  - packages/*
patchedDependencies:
  {}
allowBuilds:
  esbuild: false
ignoreScripts: true
`

const lock = ({
  importers,
  packages,
  snapshots,
}: {
  importers: string
  packages: string
  snapshots: string
}) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: true
importers:
${importers}
packages:
${packages}
snapshots:
${snapshots}
`

const platformVaryingLock = lock({
  importers: `  packages/app:
    dependencies:
      host:
        specifier: 1.0.0
        version: 1.0.0`,
  packages: `  host@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  native-darwin@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [arm64]
    os: [darwin]
  native-linux@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [x64, arm64]
    os: [linux]`,
  snapshots: `  host@1.0.0:
    optionalDependencies:
      native-darwin: 1.0.0
      native-linux: 1.0.0
  native-darwin@1.0.0: {}
  native-linux@1.0.0: {}`,
})

const cyclicLock = lock({
  importers: `  packages/app:
    dependencies:
      left:
        specifier: 1.0.0
        version: 1.0.0`,
  packages: `  left@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  outside@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  right@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
  snapshots: `  left@1.0.0:
    dependencies:
      right: 1.0.0
  outside@1.0.0: {}
  right@1.0.0:
    dependencies:
      left: 1.0.0
      outside: 1.0.0`,
})

const peerTypesLock = lock({
  importers: `  packages/app:
    dependencies:
      widget:
        specifier: 1.0.0
        version: 1.0.0(react@19.0.0)
    devDependencies:
      '@types/react':
        specifier: 19.0.0
        version: 19.0.0`,
  packages: `  '@types/react@19.0.0':
    resolution: {integrity: ${archiveIntegrity}}
  react@19.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  widget@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    peerDependencies:
      react: ^19.0.0`,
  snapshots: `  '@types/react@19.0.0': {}
  react@19.0.0: {}
  widget@1.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0`,
})

const duplicateTypesLock = lock({
  importers: `  packages/app:
    dependencies:
      widget:
        specifier: 1.0.0
        version: 1.0.0(react@19.0.0)
      legacy:
        specifier: 1.0.0
        version: 1.0.0`,
  packages: `  '@types/react@18.3.0':
    resolution: {integrity: ${archiveIntegrity}}
  '@types/react@19.0.0':
    resolution: {integrity: ${archiveIntegrity}}
  legacy@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  react@19.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  widget@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    peerDependencies:
      react: ^19.0.0`,
  snapshots: `  '@types/react@18.3.0': {}
  '@types/react@19.0.0': {}
  legacy@1.0.0:
    dependencies:
      '@types/react': 18.3.0
  react@19.0.0: {}
  widget@1.0.0(react@19.0.0):
    dependencies:
      react: 19.0.0`,
})

const projectionOf = async (
  lockfileText: string,
  workspaceTreeTargets?: Readonly<Record<string, string>>,
) => {
  const metadata = translatePnpmLock({ lockfileText, workspaceText })
  const sidecar = await generatePnpmSha256Sidecar({
    metadata,
    fetchArchive: async () => archive,
  })
  return makePnpmStoreProjection({
    metadata,
    sidecar,
    ...(workspaceTreeTargets === undefined ? {} : { workspaceTreeTargets }),
  })
}

// Match the integrity-verified package.json archive fixture in pnpm-lock tests.
const nativeEdgeArchive = (() => {
  const content = Buffer.from(JSON.stringify({ bin: { tool: './bin/tool.js' } }))
  const header = Buffer.alloc(512)
  header.write('package/package.json', 0, 'utf8')
  header.write(`${content.byteLength.toString(8).padStart(11, '0')}\0`, 124, 'ascii')
  return gzipSync(
    Buffer.concat([
      header,
      content,
      Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength),
      Buffer.alloc(1024),
    ]),
  )
})()
const nativeEdgeIntegrity = `sha512-${createHash('sha512').update(nativeEdgeArchive).digest('base64')}`

const requiredNativeLock = ({
  cyclic = false,
  optional = false,
  gated = true,
}: { cyclic?: boolean; optional?: boolean; gated?: boolean } = {}) =>
  lock({
    importers: `  packages/app:
    dependencies:
      grandparent:
        specifier: 1.0.0
        version: 1.0.0
    optionalDependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0
  packages/unrelated:
    dependencies:
      stable:
        specifier: 1.0.0
        version: 1.0.0`,
    packages: `  grandparent@1.0.0:
    resolution: {integrity: ${nativeEdgeIntegrity}}
    hasBin: true
  parent@1.0.0:
    resolution: {integrity: ${nativeEdgeIntegrity}}
    hasBin: true
  native@1.0.0:
    resolution: {integrity: ${nativeEdgeIntegrity}}
    hasBin: true${gated ? '\n    os: [linux]\n    cpu: [arm64, x64]' : ''}
  stable@1.0.0:
    resolution: {integrity: ${nativeEdgeIntegrity}}
    hasBin: true`,
    snapshots: `  grandparent@1.0.0:
    dependencies:
      parent: 1.0.0
  parent@1.0.0:
    ${optional ? 'optionalDependencies' : 'dependencies'}:${cyclic ? '\n      grandparent: 1.0.0' : ''}
      native: 1.0.0
  native@1.0.0: {}
  stable@1.0.0: {}`,
  })

const requiredNativeFixture = async (options?: Parameters<typeof requiredNativeLock>[0]) => {
  const metadata = translatePnpmLock({ lockfileText: requiredNativeLock(options), workspaceText })
  const sidecar = await generatePnpmSha256Sidecar({
    metadata,
    fetchArchive: async () => nativeEdgeArchive,
  })
  return { metadata, sidecar, projection: makePnpmStoreProjection({ metadata, sidecar }) }
}

const renderedRule = (rendered: string, target: string) =>
  rendered.split('\n\n').find((block) => block.includes(`    name = "${target}",`))!

describe('required-edge platform availability', () => {
  const linuxPlatforms = ['linux_aarch64', 'linux_x86_64']

  it('restricts an ungated parent and its grandparent to their required native child', async () => {
    const { metadata, projection } = await requiredNativeFixture()
    for (const storeKey of ['parent@1.0.0', 'grandparent@1.0.0']) {
      expect(
        packageAllowed({ metadata, packageKey: storeKey, platform: portablePnpmPlatform }),
      ).toBe(true)
      const entry = projection.entries.find((candidate) => candidate.storeKey === storeKey)!
      expect(entry.platforms).toEqual(linuxPlatforms)
      expect(entry.variants.flatMap((variant) => variant.platforms)).toEqual(linuxPlatforms)
      expect(entry.variants).toHaveLength(1)
    }
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    expect(view.platforms).toEqual(linuxPlatforms)
    expect(view.variants.flatMap((variant) => variant.platforms)).toEqual(linuxPlatforms)
    for (const platform of ['javascript_portable', 'macos_aarch64'] as const) {
      expect(view.variants.find((variant) => variant.platforms.includes(platform))).toBeUndefined()
    }
  })

  it('retains every required link, closure member, and binary on every supported tuple', async () => {
    const { projection } = await requiredNativeFixture()
    const parent = projection.entries.find((entry) => entry.storeKey === 'parent@1.0.0')!
    const grandparent = projection.entries.find((entry) => entry.storeKey === 'grandparent@1.0.0')!
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    for (const platform of view.platforms) {
      expect(
        parent.variants.find((variant) => variant.platforms.includes(platform))!.edges,
      ).toEqual({
        native: { kind: 'entry', storeKey: 'native@1.0.0' },
      })
      expect(
        grandparent.variants.find((variant) => variant.platforms.includes(platform))!.edges,
      ).toEqual({
        parent: { kind: 'entry', storeKey: 'parent@1.0.0' },
      })
      const variant = view.variants.find((candidate) => candidate.platforms.includes(platform))!
      expect(variant.direct).toEqual({
        grandparent: { kind: 'entry', storeKey: 'grandparent@1.0.0' },
        native: { kind: 'entry', storeKey: 'native@1.0.0' },
      })
      expect(variant.closure).toEqual(['grandparent@1.0.0', 'native@1.0.0', 'parent@1.0.0'])
      expect(variant.bins).toEqual({ tool: 'native@1.0.0\tbin/tool.js' })
    }
    for (const entry of projection.entries) {
      expect(entry.bins).toEqual({ tool: 'bin/tool.js' })
    }
  })

  it('propagates a required external restriction through all members of a required SCC', async () => {
    const { projection } = await requiredNativeFixture({ cyclic: true })
    expect(projection.sccs.map((scc) => scc.members)).toEqual([
      ['grandparent@1.0.0', 'parent@1.0.0'],
    ])
    for (const entry of projection.entries.filter(
      (candidate) => candidate.sccIndex !== undefined,
    )) {
      expect(entry.platforms).toEqual(linuxPlatforms)
      expect(entry.variants.flatMap((variant) => variant.platforms)).toEqual(linuxPlatforms)
      expect(Object.keys(entry.variants[0]!.edges)).not.toEqual([])
    }
    const rendered = renderPnpmStoreBuck(projection)
    expect(rendered).toContain('"grandparent@1.0.0\\tparent": "parent@1.0.0"')
    expect(rendered).toContain('"parent@1.0.0\\tgrandparent": "grandparent@1.0.0"')
  })

  it('renders explicit rejection metadata for unsupported entry and importer configurations', async () => {
    const { projection } = await requiredNativeFixture()
    const rendered = renderPnpmStoreBuck(projection)
    const restricted = [
      ...projection.entries.filter((entry) => entry.platforms.length < pnpmPlatforms.length),
      ...projection.views.filter((view) => view.platforms.length < pnpmPlatforms.length),
    ]
    expect(restricted).toHaveLength(4)
    for (const owner of restricted) {
      const block = renderedRule(rendered, owner.target)
      expect(block).toContain('    unavailable_by_platform = {')
      for (const platform of pnpmPlatforms) {
        const reason = block.match(
          new RegExp(`^        "${platform}": ("(?:[^"\\\\]|\\\\.)*"),$`, 'm'),
        )
        expect(reason).not.toBeNull()
        expect(JSON.parse(reason![1]!)).toEqual(
          owner.platforms.includes(platform) ? '' : expect.stringMatching(/\S/),
        )
      }
    }
    const stable = projection.entries.find((entry) => entry.storeKey === 'stable@1.0.0')!
    const unrelated = projection.views.find((view) => view.importer === 'packages/unrelated')!
    expect(renderedRule(rendered, stable.target)).not.toContain('unavailable_by_platform')
    expect(renderedRule(rendered, unrelated.target)).not.toContain('unavailable_by_platform')
  })

  it('keeps optional native edges filtered without restricting their owners or importers', async () => {
    const { projection } = await requiredNativeFixture({ optional: true })
    const parent = projection.entries.find((entry) => entry.storeKey === 'parent@1.0.0')!
    const grandparent = projection.entries.find((entry) => entry.storeKey === 'grandparent@1.0.0')!
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    expect(parent.platforms).toEqual(pnpmPlatforms)
    expect(grandparent.platforms).toEqual(pnpmPlatforms)
    expect(view.platforms).toEqual(pnpmPlatforms)
    for (const platform of pnpmPlatforms) {
      const variant = view.variants.find((candidate) => candidate.platforms.includes(platform))!
      const edges = parent.variants.find((candidate) =>
        candidate.platforms.includes(platform),
      )!.edges
      expect(Object.keys(edges)).toEqual(linuxPlatforms.includes(platform) ? ['native'] : [])
      expect(Object.keys(variant.direct)).toEqual(
        linuxPlatforms.includes(platform) ? ['grandparent', 'native'] : ['grandparent'],
      )
      expect(variant.closure).toEqual(
        linuxPlatforms.includes(platform)
          ? ['grandparent@1.0.0', 'native@1.0.0', 'parent@1.0.0']
          : ['grandparent@1.0.0', 'parent@1.0.0'],
      )
      expect(variant.bins).toEqual({
        tool: `${linuxPlatforms.includes(platform) ? 'native' : 'grandparent'}@1.0.0\tbin/tool.js`,
      })
    }
  })

  it.each(['linked', 'injected'] as const)(
    'filters an optional %s workspace against its required native closure',
    async (kind) => {
      const metadata = translatePnpmLock({
        workspaceText,
        lockfileText: lock({
          importers: `  packages/app:
    optionalDependencies:
      workspace-lib:
        specifier: workspace:*
        version: ${kind === 'linked' ? 'link:../lib' : 'file:packages/lib'}
  packages/lib:
    dependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0`,
          packages: `  native@1.0.0:
    resolution: {integrity: ${nativeEdgeIntegrity}}
    os: [linux]${kind === 'injected' ? '\n  workspace-lib@file:packages/lib:\n    resolution: {directory: packages/lib, type: directory}' : ''}`,
          snapshots: `  native@1.0.0: {}${kind === 'injected' ? '\n  workspace-lib@file:packages/lib: {}' : ''}`,
        }),
      })
      const sidecar = await generatePnpmSha256Sidecar({
        metadata,
        fetchArchive: async () => nativeEdgeArchive,
      })
      const projection = makePnpmStoreProjection({ metadata, sidecar })
      const owner = projection.views.find((view) => view.importer === 'packages/app')!
      const dependency = projection.views.find((view) => view.importer === 'packages/lib')!
      const key = workspaceKey('packages/lib')
      expect(owner.platforms).toEqual(pnpmPlatforms)
      expect(dependency.platforms).toEqual(linuxPlatforms)
      for (const platform of pnpmPlatforms) {
        const direct = owner.variants.find((variant) =>
          variant.platforms.includes(platform),
        )!.direct
        expect(direct).toEqual(
          linuxPlatforms.includes(platform)
            ? {
                'workspace-lib': {
                  kind: 'workspace',
                  workspaceKey: key,
                  workspacePath: 'packages/lib',
                },
              }
            : {},
        )
      }
      const block = renderedRule(renderPnpmStoreBuck(projection), owner.target)
      expect(block).not.toContain('unavailable_by_platform')
      for (const field of ['workspace_trees', 'workspace_dependencies']) {
        const selected = block.split(`${field}_by_platform = {`)[1]!.split('\n    },')[0]!
        for (const platform of pnpmPlatforms) {
          const branch = selected.match(
            new RegExp(`"${platform}": \\{([\\s\\S]*?)\\n        \\},`),
          )![1]!
          if (linuxPlatforms.includes(platform)) expect(branch).toContain(key)
          else expect(branch.trim()).toBe('')
        }
      }
    },
  )

  it('leaves an unrelated supported importer projection and rendered rule byte-stable', async () => {
    const before = (await requiredNativeFixture({ gated: false })).projection
    const after = (await requiredNativeFixture()).projection
    const beforeView = before.views.find((view) => view.importer === 'packages/unrelated')!
    const afterView = after.views.find((view) => view.importer === 'packages/unrelated')!
    expect(afterView).toEqual(beforeView)
    expect(renderedRule(renderPnpmStoreBuck(after), afterView.target)).toBe(
      renderedRule(renderPnpmStoreBuck(before), beforeView.target),
    )
  })

  it('still rejects missing archive metadata, stale fingerprints, and invalid digests globally', async () => {
    const { metadata, sidecar } = await requiredNativeFixture()
    expect(() =>
      makePnpmStoreProjection({ metadata, sidecar: { ...sidecar, packages: {} } }),
    ).toThrow(/stale sha256 sidecar package identity set/)
    expect(() =>
      makePnpmStoreProjection({
        metadata,
        sidecar: { ...sidecar, lockfileFingerprint: `sha256:${'0'.repeat(64)}` },
      }),
    ).toThrow(/stale sha256 sidecar lock fingerprint/)
    expect(() =>
      makePnpmStoreProjection({
        metadata,
        sidecar: {
          ...sidecar,
          packages: {
            ...sidecar.packages,
            'native@1.0.0': { ...sidecar.packages['native@1.0.0']!, sha256: '0'.repeat(64) },
          },
        },
      }),
    ).toThrow(/sha256 sidecar fingerprint mismatch/)
    expect(() =>
      decodePnpmSha256Sidecar({
        ...sidecar,
        packages: {
          ...sidecar.packages,
          'native@1.0.0': { ...sidecar.packages['native@1.0.0']!, sha256: 'invalid' },
        },
      }),
    ).toThrow(/must be lowercase sha256/)
  })

  it.each(['required', 'optional'] as const)(
    'rejects missing %s snapshot metadata even when the owner is unsupported',
    async (kind) => {
      const { metadata, sidecar } = await requiredNativeFixture({ optional: kind === 'optional' })
      const snapshots = Object.fromEntries(
        Object.entries(metadata.snapshots).filter(([key]) => key !== 'native@1.0.0'),
      )
      expect(() =>
        makePnpmStoreProjection({ metadata: { ...metadata, snapshots }, sidecar }),
      ).toThrow(/unknown snapshot native@1.0.0/)
    },
  )

  it('keeps a mixed optional SCC available while excluding its gated member on unsupported tuples', async () => {
    const metadata = translatePnpmLock({
      lockfileText: requiredNativeLock({ optional: true }).replace(
        '  native@1.0.0: {}',
        '  native@1.0.0:\n    dependencies:\n      parent: 1.0.0',
      ),
      workspaceText,
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => nativeEdgeArchive,
    })
    const projection = makePnpmStoreProjection({ metadata, sidecar })
    expect(projection.sccs.map((scc) => scc.members)).toEqual([['native@1.0.0', 'parent@1.0.0']])
    const native = projection.entries.find((entry) => entry.storeKey === 'native@1.0.0')!
    const parent = projection.entries.find((entry) => entry.storeKey === 'parent@1.0.0')!
    expect(native.platforms).toEqual(linuxPlatforms)
    expect(parent.platforms).toEqual(pnpmPlatforms)
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    expect(view.platforms).toEqual(pnpmPlatforms)
    for (const platform of pnpmPlatforms) {
      const variant = view.variants.find((candidate) => candidate.platforms.includes(platform))!
      expect(variant.closure.includes('native@1.0.0')).toBe(linuxPlatforms.includes(platform))
      expect(variant.closure).toContain('parent@1.0.0')
    }
    const component = renderedRule(renderPnpmStoreBuck(projection), projection.sccs[0]!.target)
    expect(component).toContain('    members_by_platform = {')
    expect(component).not.toContain('unavailable_by_platform')
  })

  it('projects a required closure with no admitted platform without inventing an empty variant', async () => {
    const metadata = translatePnpmLock({
      lockfileText: requiredNativeLock().replace('os: [linux]', 'os: [win32]'),
      workspaceText,
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => nativeEdgeArchive,
    })
    const projection = makePnpmStoreProjection({ metadata, sidecar })
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    expect(view.platforms).toEqual([])
    expect(view.variants).toEqual([])
    for (const entry of projection.entries.filter(
      (candidate) => candidate.packageName !== 'stable',
    )) {
      expect(entry.platforms).toEqual([])
      expect(entry.variants).toEqual([])
    }
    const block = renderedRule(renderPnpmStoreBuck(projection), view.target)
    expect(block).toContain('    unavailable_by_platform = {')
    for (const platform of pnpmPlatforms) {
      expect(block).toContain(`has no complete required dependency closure on ${platform}`)
    }
  })
})

describe('normalized store projection', () => {
  it('derives one platform-selected variant set per differing lockfile edge set', async () => {
    const projection = await projectionOf(platformVaryingLock)
    const host = projection.entries.find((entry) => entry.storeKey === 'host@1.0.0')!

    // Two Linux platforms resolve the same edge, macOS resolves another, and
    // the portable platform resolves neither native sibling: the variant count
    // follows the lockfile instead of a declared constant.
    expect(host.variants).toHaveLength(3)
    expect(host.variants.map((variant) => variant.platforms)).toEqual(
      expect.arrayContaining([
        ['javascript_portable'],
        ['linux_aarch64', 'linux_x86_64'],
        ['macos_aarch64'],
      ]),
    )
    const portable = host.variants.find((variant) =>
      variant.platforms.includes('javascript_portable'),
    )!
    expect(Object.keys(portable.edges)).toEqual([])
    const darwin = host.variants.find((variant) => variant.platforms.includes('macos_aarch64'))!
    expect(Object.keys(darwin.edges)).toEqual(['native-darwin'])
    expect(platformVaryingEntries(projection).map((entry) => entry.storeKey)).toEqual([
      'host@1.0.0',
    ])
  })

  it('keeps a platform-restricted package invariant instead of selecting it', async () => {
    const projection = await projectionOf(platformVaryingLock)
    const native = projection.entries.find((entry) => entry.storeKey === 'native-darwin@1.0.0')!

    expect(native.platforms).toEqual(['macos_aarch64'])
    expect(native.variants).toHaveLength(1)
    expect(platformVaryingEntries(projection)).not.toContain(native)
  })

  it('groups a real cycle into one component and leaves its acyclic neighbour alone', async () => {
    const projection = await projectionOf(cyclicLock)

    expect(projection.sccs).toHaveLength(1)
    expect(projection.sccs[0]!.members).toEqual(['left@1.0.0', 'right@1.0.0'])
    const members = projection.entries.filter((entry) => entry.sccIndex !== undefined)
    expect(members.map((entry) => entry.storeKey)).toEqual(['left@1.0.0', 'right@1.0.0'])
    const outside = projection.entries.find((entry) => entry.storeKey === 'outside@1.0.0')!
    expect(outside.sccIndex).toBeUndefined()
  })

  it('gives every component member a distinct pnpm namespace and one shared group target', async () => {
    const projection = await projectionOf(cyclicLock)
    const members = projection.entries.filter((entry) => entry.sccIndex !== undefined)

    expect(new Set(members.map((entry) => entry.storeKey)).size).toBe(members.length)
    expect(new Set(members.map((entry) => entry.sccIndex)).size).toBe(1)
    const rendered = renderPnpmStoreBuck(projection)
    expect(rendered).toContain('pnpm_store_scc(')
    // Members carry their edges on the group, never as their own entry edges.
    expect(rendered).toContain(`scc = ":${projection.sccs[0]!.target}"`)
    expect(rendered).toContain('"left@1.0.0\\tright": "right@1.0.0"')
    expect(rendered).toContain('"right@1.0.0\\tleft": "left@1.0.0"')
  })

  it('selects absent and same-name differing SCC internal edges per platform', async () => {
    const projection = await projectionOf(cyclicLock)
    const left = projection.entries.find((entry) => entry.storeKey === 'left@1.0.0')!
    const rightEdge = left.variants[0]!.edges.right!
    const varyingProjection = {
      ...projection,
      entries: projection.entries.map((entry) =>
        entry === left
          ? Object.assign({}, entry, {
              variants: [
                {
                  edges: { right: { kind: 'entry', storeKey: 'left@1.0.0' } },
                  platforms: pnpmPlatforms.filter((platform) => platform !== 'macos_aarch64'),
                },
                {
                  edges: { optionalRight: rightEdge, right: rightEdge },
                  platforms: pnpmPlatforms.filter((platform) => platform === 'macos_aarch64'),
                },
              ],
            })
          : entry,
      ),
    }

    const rendered = renderPnpmStoreBuck(varyingProjection)
    const component = rendered.slice(
      rendered.indexOf('pnpm_store_scc('),
      rendered.indexOf('pnpm_store_entry('),
    )
    expect(component).toContain('internal_edges_by_platform = {')
    expect(component.match(/"left@1.0.0\\toptionalRight": "right@1.0.0"/g)).toHaveLength(1)
    expect(component.match(/"left@1.0.0\\tright": "left@1.0.0"/g)).toHaveLength(3)
    expect(component.match(/"left@1.0.0\\tright": "right@1.0.0"/g)).toHaveLength(1)
    expect(component.match(/"right@1.0.0\\tleft": "left@1.0.0"/g)).toHaveLength(4)
    // The select covers the portable platform explicitly; nothing falls
    // through to a default branch.
    expect(component).toContain('"javascript_portable":')
  })

  it('projects an importer as direct links plus a closure, never as copied dependencies', async () => {
    const projection = await projectionOf(cyclicLock)
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    const variant = view.variants[0]!

    expect(Object.keys(variant.direct)).toEqual(['left'])
    expect(variant.closure).toEqual(['left@1.0.0', 'outside@1.0.0', 'right@1.0.0'])
    // A view names entries; it never restates their dependency edges, which is
    // what previously duplicated the closure into every consumer.
    const rendered = renderPnpmStoreBuck(projection)
    const viewBlock = rendered.slice(rendered.indexOf(`name = "${view.target}"`))
    expect(viewBlock).not.toContain('package_dependencies')
    expect(viewBlock).not.toContain('dependencies_by_platform')
    expect(viewBlock).toContain('closure = {')
    expect(viewBlock).toContain('direct = {')
  })

  it('declares one entry per snapshot no matter how many importers consume it', async () => {
    const projection = await projectionOf(
      lock({
        importers: `  packages/a:
    dependencies:
      shared:
        specifier: 1.0.0
        version: 1.0.0
  packages/b:
    dependencies:
      shared:
        specifier: 1.0.0
        version: 1.0.0`,
        packages: `  shared@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  shared@1.0.0: {}',
      }),
    )

    expect(projection.entries.map((entry) => entry.storeKey)).toEqual(['shared@1.0.0'])
    expect(projection.views).toHaveLength(2)
    for (const view of projection.views) {
      expect(view.variants[0]!.closure).toEqual(['shared@1.0.0'])
    }
  })

  it('keeps an injected workspace package as an importer workspace edge', async () => {
    // pnpm 12 injects workspace packages by default, so a direct workspace
    // dependency arrives as a `file:<dir>` snapshot instead of a `link:`
    // reference. Both spellings denote the same edge, so the importer must
    // still name the workspace tree instead of dropping the dependency or
    // materialising a tree nothing points at.
    const projection = await projectionOf(
      lock({
        importers: `  packages/app:
    dependencies:
      workspace-lib:
        specifier: workspace:*
        version: file:packages/lib
    dependenciesMeta:
      workspace-lib:
        injected: true
  packages/lib:
    dependencies:
      bar:
        specifier: 2.0.0
        version: 2.0.0`,
        packages: `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  workspace-lib@file:packages/lib:
    resolution: {directory: packages/lib, type: directory}`,
        snapshots: `  bar@2.0.0: {}
  workspace-lib@file:packages/lib:
    dependencies:
      bar: 2.0.0`,
      }),
    )
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    const expectedKey = workspaceKey('packages/lib')

    expect(view.variants[0]!.direct['workspace-lib']).toEqual({
      kind: 'workspace',
      workspaceKey: expectedKey,
      workspacePath: 'packages/lib',
    })
    expect(view.workspaceTrees[expectedKey]).toBe('//packages/lib:package_tree')
  })

  it.each(['injected', 'linked'] as const)(
    'projects an %s frozen source through its declared tree without changing workspace identity',
    async (kind) => {
      const sourcePath = '.devenv/pnpm-source-inputs/current/repos/sdk/client'
      const sourceTarget = 'pnpm_sources//:sdk_client_package_tree'
      const sourceLock = lock({
        importers: `  packages/app:
    dependencies:
      source-lib:
        specifier: file:${sourcePath}
        version: ${kind === 'injected' ? `file:${sourcePath}` : `link:../../${sourcePath}`}
      local-lib:
        specifier: workspace:*
        version: link:../local`,
        packages: `  source-lib@file:${sourcePath}:
    resolution: {directory: ${sourcePath}, type: directory}`,
        snapshots: `  source-lib@file:${sourcePath}: {}`,
      })
      const ordinary = await projectionOf(sourceLock)
      const projected = await projectionOf(sourceLock, { [sourcePath]: sourceTarget })
      const view = projected.views[0]!
      const sourceKey = workspaceKey(sourcePath)
      const localKey = workspaceKey('packages/local')

      expect(view.workspaceTrees).toEqual({
        [sourceKey]: sourceTarget,
        [localKey]: '//packages/local:package_tree',
      })
      expect(view.variants).toEqual(ordinary.views[0]!.variants)
      expect(projected.entries).toEqual(ordinary.entries)
      expect(projected.fingerprint).not.toBe(ordinary.fingerprint)
      expect(view.variants[0]!.direct['source-lib']).toEqual({
        kind: 'workspace',
        workspaceKey: sourceKey,
        workspacePath: sourcePath,
      })

      const rendered = renderPnpmStoreBuck(projected)
      expect(rendered).toContain(`"${sourceKey}": "${sourceTarget}"`)
      expect(rendered).toContain(`"${localKey}": "//packages/local:package_tree"`)
      expect(rendered).not.toContain(`//${sourcePath}:package_tree`)
      // Matching a live-checkout suffix must not silently replace frozen bytes.
      const suffixOnly = await projectionOf(sourceLock, {
        'repos/sdk/client': sourceTarget,
      })
      expect(suffixOnly.fingerprint).toBe(ordinary.fingerprint)
    },
  )

  it.each(['constructor', 'toString', '__proto__'])(
    'maps only own target declarations for workspace path %s',
    async (sourcePath) => {
      const sourceLock = lock({
        importers: `  packages/app:
    dependencies:
      source-lib:
        specifier: workspace:*
        version: link:../../${sourcePath}`,
        packages: '  {}',
        snapshots: '  {}',
      })
      const sourceKey = workspaceKey(sourcePath)
      const ordinary = await projectionOf(sourceLock)
      expect(ordinary.views[0]!.workspaceTrees[sourceKey]).toBe(`//${sourcePath}:package_tree`)
      const unrelated = await projectionOf(sourceLock, { 'repos/sdk/client': 'pnpm_sources//:sdk' })
      expect(unrelated.fingerprint).toBe(ordinary.fingerprint)
      const ownTargets = Object.fromEntries([[sourcePath, 'pnpm_sources//:sdk']])
      const projected = await projectionOf(sourceLock, ownTargets)
      expect(projected.views[0]!.workspaceTrees[sourceKey]).toBe('pnpm_sources//:sdk')
      expect(renderPnpmStoreBuck(projected)).toContain(`"${sourceKey}": "pnpm_sources//:sdk"`)
    },
  )

  it("links a peer's type companion into the entry that declares the peer", async () => {
    const projection = await projectionOf(peerTypesLock)
    const widget = projection.entries.find(
      (entry) => entry.storeKey === 'widget@1.0.0_react@19.0.0',
    )!

    // `widget` never declares `@types/react`; it declares `react` as a peer,
    // and its own declaration files resolve `react` types through the
    // companion. pnpm supplies that through its hoisted layer, which an
    // isolated entry does not have, so the edge is declared here instead.
    expect(Object.keys(widget.variants[0]!.edges).toSorted()).toEqual(['@types/react', 'react'])
    expect(widget.variants[0]!.edges['@types/react']).toEqual({
      kind: 'entry',
      storeKey: '@types+react@19.0.0',
    })
    // Every platform resolves the same companion, so no select() appears.
    expect(widget.variants).toHaveLength(1)

    // A package without peers gains nothing, and the companion entry is part
    // of the consuming view's closure because the entry graph reaches it.
    const react = projection.entries.find((entry) => entry.storeKey === 'react@19.0.0')!
    expect(react.variants[0]!.edges).toEqual({})
    const view = projection.views.find((candidate) => candidate.importer === 'packages/app')!
    expect(view.variants[0]!.closure).toEqual([
      '@types+react@19.0.0',
      'react@19.0.0',
      'widget@1.0.0_react@19.0.0',
    ])
    expect(renderPnpmStoreBuck(projection)).toContain('"@types/react": ":entry_types_react_19_0_0')
  })

  it('rejects a type companion the repository resolves to two versions', async () => {
    await expect(projectionOf(duplicateTypesLock)).rejects.toThrow(
      '@types/react resolves to 18.3.0, 19.0.0; a type companion must have one repository-wide version',
    )
  })
})

describe('normalized store projection of the real lockfile', () => {
  const metadata = translatePnpmLock({
    lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
    workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
  })
  const sidecar = decodePnpmSha256Sidecar(
    JSON.parse(readFileSync('buck2/dependencies/pnpm-lock.sha256.json', 'utf8')),
  )
  const projection = makePnpmStoreProjection({ metadata, sidecar })

  it('finds exactly the five real multi-member components', () => {
    expect(projection.sccs.map((scc) => scc.members)).toEqual([
      ['@babel+core@7.29.7', '@babel+helper-module-transforms@7.29.7_@babel+core@7.29.7'],
      [
        '@eslint-community+eslint-utils@4.10.1_eslint@10.10.0_jiti@2.7.0',
        'eslint@10.10.0_jiti@2.7.0',
      ],
      [
        '@storybook+builder-vite@10.6.0_patch_hash=3ea63b6347343243dbebc21be698afb9635d47f3fd2a5c2bb7b10c002250d_627b9302f264f878',
        '@storybook+react-dom-shim@10.6.0_@types+react-dom@19.2.7_@types+react@19.2.18_@types+react@19.2.18_reac_690867bbf0498919',
        '@storybook+react-vite@10.6.0_@types+react-dom@19.2.7_@types+react@19.2.18_@types+react@19.2.18_react-do_9b5eccc39f239997',
        '@storybook+react@10.6.0_@types+react-dom@19.2.7_@types+react@19.2.18_@types+react@19.2.18_react-dom@19._c8fa65d991fb5130',
        'storybook@10.6.0_@types+react-dom@19.2.7_@types+react@19.2.18_@types+react@19.2.18_prettier@3.9.6_react_da9aab27e30e1021',
      ],
      [
        '@vitest+browser-playwright@5.0.3_playwright@1.63.0_vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_jiti@2.7.0_vitest@5.0.3',
        '@vitest+browser@5.0.3_vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_jiti@2.7.0_vitest@5.0.3',
        '@vitest+ui@5.0.3_vitest@5.0.3',
        'vitest@5.0.3_@opentelemetry+api@1.9.1_@types+node@26.5.0_@vitest+browser-playwright@5.0.3_@vitest+ui@5._1c9a61b8ae5e04be',
      ],
      ['browserslist@4.28.8', 'update-browserslist-db@1.3.2_browserslist@4.28.8'],
    ])
    expect(new Set(projection.sccs.flatMap((scc) => scc.members)).size).toBe(
      projection.sccs.reduce((total, scc) => total + scc.members.length, 0),
    )
  })

  it('resolves the React type companions every peer-typed entry needs', () => {
    const typesReact = projection.entries.find((entry) => entry.packageName === '@types/react')!
    const ariaComponents = projection.entries.find(
      (entry) => entry.packageName === 'react-aria-components',
    )!

    // `react` ships no declarations, so `react-aria-components`' own `.d.ts`
    // files only typecheck when the companion is reachable from the entry that
    // declares `react` as a peer.
    expect(ariaComponents.variants[0]!.edges['@types/react']).toEqual({
      kind: 'entry',
      storeKey: typesReact.storeKey,
    })

    // Derived, not declared: whichever entries peer a package with a companion
    // in this lockfile are exactly the entries that gain the edge.
    const peerTyped = projection.entries.filter((entry) => {
      const snapshot = metadata.snapshots[entry.snapshot]!
      const declared = new Set([
        ...Object.keys(snapshot.dependencies),
        ...Object.keys(snapshot.optionalDependencies),
      ])
      return entry.variants.some((variant) =>
        Object.keys(variant.edges).some(
          (name) => name.startsWith('@types/') === true && declared.has(name) === false,
        ),
      )
    })
    expect(peerTyped.map((entry) => entry.packageName)).toContain('react-aria-components')
    for (const entry of peerTyped) {
      const peers = metadata.snapshots[entry.snapshot]!.peerIdentities
      expect(peers.length).toBeGreaterThan(0)
    }
  })

  it('derives the platform-varying entries the current lockfile actually has', () => {
    const varying = platformVaryingEntries(projection).map((entry) => entry.storeKey)

    // Assert the current lock's exact identities, including peer-qualified
    // packages whose optional native dependency edges vary by platform.
    expect(varying).toEqual([
      '@number0+iroh@1.1.0',
      '@opentui+core@0.5.11_typescript@7.0.2_web-tree-sitter@0.25.10',
      'esbuild@0.28.2',
      'lightningcss@1.33.0',
      'next@16.2.6_@babel+core@7.29.7_@opentelemetry+api@1.9.1_@playwright+test@1.63.0_react-dom@19.2.8_react@_d75b6ba524ebce45',
      'oxc-parser@0.127.0',
      'oxc-resolver@11.21.2',
      'oxlint-tsgolint@7.0.2001',
      'oxlint@1.82.0_oxlint-tsgolint@7.0.2001',
      'rolldown@1.2.7',
      'sharp@0.34.5',
      'typescript@7.0.2',
      'vite@8.2.2_@types+node@26.5.0_esbuild@0.28.2_jiti@2.7.0',
    ])
  })

  it('declares one entry per snapshot and one view per importer', () => {
    expect(projection.entries).toHaveLength(743)
    expect(new Set(projection.entries.map((entry) => entry.storeKey)).size).toBe(743)
    expect(projection.views).toHaveLength(Object.keys(metadata.importers).length)
    expect(computeStoreSccs({ metadata })).toEqual(projection.sccs.map((scc) => scc.members))
  })

  it('renders a deterministic declaration whose selects appear only where edges vary', () => {
    const rendered = renderPnpmStoreBuck(projection)

    expect(rendered).toBe(renderPnpmStoreBuck(projection))
    // A platform-restricted package with nonempty dependencies also needs a
    // select: its unsupported platforms have no edges. Counting only entries
    // with multiple admitted variants misses the sharp -> libvips first hops.
    const configuredEntries = projection.entries
      .filter(
        (entry) =>
          entry.sccIndex === undefined &&
          new Set(
            pnpmPlatforms.map((platform) =>
              JSON.stringify(
                entry.variants.find((variant) => variant.platforms.includes(platform))?.edges ?? {},
              ),
            ),
          ).size > 1,
      )
      .map((entry) => entry.storeKey)
    const renderedConfiguredEntries = rendered
      .split('pnpm_store_entry(\n')
      .slice(1)
      .map((block) => block.split('\n)')[0]!)
      .filter((block) => block.includes('    dependencies_by_platform = {'))
      .map((block) => block.match(/^    store_key = "([^"]+)",$/m)?.[1])
    expect(renderedConfiguredEntries).toEqual(configuredEntries)
    for (const platform of pnpmPlatforms) {
      expect(rendered).toContain(`"${platform}": {`)
    }
  })

  it('grafts each Nix-built native addon onto exactly one shared store entry', () => {
    const rendered = renderPnpmStoreBuck(projection)
    const grafted = projection.entries.filter(
      (entry) => nixGraftedStoreOverridePackages[entry.packageName] !== undefined,
    )

    // The policy names the families; the lockfile decides how many snapshots
    // each has. `node-pty` resolves to one snapshot, so one entry carries the
    // addon for the whole repository.
    expect(grafted.map((entry) => entry.storeKey)).toEqual(['node-pty@1.1.0'])
    expect(
      [
        ...rendered.matchAll(
          /^ {4}package_override = read_config\("test_capabilities", "(?<name>[^"]+)", ""\),$/gm,
        ),
      ].map((match) => match.groups!['name']),
    ).toEqual(grafted.map((entry) => entry.packageName))

    // Anti-duplication: the addon is declared once and named by many
    // consumers, never copied into an importer view or a second entry.
    const [entry] = grafted
    expect(entry!.sccIndex).toBeUndefined()
    expect(rendered.match(new RegExp(`^ {4}name = "${entry!.target}",$`, 'gm'))).toHaveLength(1)
    expect(rendered.match(new RegExp(`": ":${entry!.target}",$`, 'gm'))!.length).toBeGreaterThan(1)
  })
})

describe('platform-gated package derivation', () => {
  const metadata = translatePnpmLock({ lockfileText: platformVaryingLock, workspaceText })

  it('names exactly the packages the lockfile gates on cpu, os, or libc', () => {
    // `host` resolves everywhere, so it belongs in a portable product; the two
    // native siblings resolve only somewhere, so they never can.
    expect(platformGatedPackageNames(metadata)).toEqual(['native-darwin', 'native-linux'])
  })

  it('renders the gated set as one Buck target with no capability for an ungrafted family', () => {
    const rendered = renderPnpmPlatformGatedPackages({ metadata })

    expect(rendered).toContain('name = "platform_gated_packages",')
    expect(rendered).toContain('"native-darwin": ["native-darwin"],')
    expect(rendered).toContain('"native-linux": ["native-linux"],')
    // Neither family is Nix-grafted, so no product owes a host capability.
    expect(rendered).not.toContain('-native')
  })

  it('is one of the admitted platforms a store select must cover', () => {
    expect(pnpmPlatforms).toContain(portablePnpmPlatform)
  })

  it('admits a package only when the lockfile puts no gate on it at all', () => {
    const allowed = (packageKey: string) =>
      packageAllowed({ metadata, packageKey, platform: portablePnpmPlatform })

    expect(allowed('host@1.0.0')).toBe(true)
    expect(allowed('native-linux@1.0.0')).toBe(false)
    expect(allowed('native-darwin@1.0.0')).toBe(false)
  })

  it('rejects a libc-only gate, which a machine-shaped platform consults only on Linux', () => {
    const libcOnly = translatePnpmLock({
      lockfileText: lock({
        importers: `  packages/app:
    dependencies:
      musl-only:
        specifier: 1.0.0
        version: 1.0.0`,
        packages: `  musl-only@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    libc: [musl]`,
        snapshots: `  musl-only@1.0.0: {}`,
      }),
      workspaceText,
    })

    expect(
      packageAllowed({
        metadata: libcOnly,
        packageKey: 'musl-only@1.0.0',
        platform: portablePnpmPlatform,
      }),
    ).toBe(false)
    expect(platformGatedPackageNames(libcOnly)).toEqual(['musl-only'])
  })

  it('carries OpenTUI musl dispatch packages on glibc Linux for Bun', () => {
    const opentui = translatePnpmLock({
      lockfileText: lock({
        importers: `  packages/app:
    optionalDependencies:
      '@opentui/core-linux-x64-musl':
        specifier: 0.5.11
        version: 0.5.11`,
        packages: `  '@opentui/core-linux-x64-musl@0.5.11':
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [x64]
    os: [linux]
    libc: [musl]`,
        snapshots: `  '@opentui/core-linux-x64-musl@0.5.11': {}`,
      }),
      workspaceText,
    })

    expect(
      packageAllowed({
        metadata: opentui,
        packageKey: '@opentui/core-linux-x64-musl@0.5.11',
        platform: 'linux_x86_64',
      }),
    ).toBe(true)
  })
})
