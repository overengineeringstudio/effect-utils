import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

import { describe, expect, it } from 'vitest'

import {
  decodePnpmSha256Sidecar,
  generatePnpmSha256Sidecar,
  translatePnpmLock,
  validatePnpmSha256Sidecar,
} from './pnpm-lock.ts'
import { renderPnpmPackageTargets } from './pnpm-store-buck.ts'
import {
  assertArchiveAllowedForTier,
  resolveArchiveOrigin,
  seedArchive,
  verifyArchive,
} from './seed-archives.ts'

const archive = new TextEncoder().encode('archive bytes')
const archiveIntegrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`
const otherArchive = new TextEncoder().encode('other archive bytes')
const otherIntegrity = `sha512-${createHash('sha512').update(otherArchive).digest('base64')}`

const npmArchive = (manifest: unknown): Uint8Array => {
  const content = Buffer.from(JSON.stringify(manifest))
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
}

const workspace = ({
  allowBuilds = '  esbuild: false',
  patches = '',
}: {
  allowBuilds?: string
  patches?: string
} = {}) => `packages:
  - packages/*
patchedDependencies:
${patches === '' ? '  {}' : patches}
allowBuilds:
${allowBuilds}
ignoreScripts: true
`

const lock = ({
  importers = `  packages/app:
    dependencies:
      alias:
        specifier: npm:bar@2
        version: bar@2.0.0
      foo:
        specifier: 1.0.0
        version: 1.0.0(peer@3.0.0)
      workspace-lib:
        specifier: workspace:*
        version: link:../lib`,
  packages = `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}
  foo@1.0.0:
    resolution: {integrity: ${otherIntegrity}}
    cpu: [x64, arm64]
    os: [linux, darwin]
    libc: [glibc]
  peer@3.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
  overrides = '',
  patchedDependencies = '',
  snapshots = `  bar@2.0.0: {}
  foo@1.0.0(peer@3.0.0):
    dependencies:
      alias: bar@2.0.0
      peer: 3.0.0
  peer@3.0.0: {}`,
}: {
  importers?: string
  packages?: string
  overrides?: string
  patchedDependencies?: string
  snapshots?: string
} = {}) => `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  injectWorkspacePackages: true
${overrides === '' ? '' : `overrides:\n${overrides}\n`}${patchedDependencies === '' ? '' : `patchedDependencies:\n${patchedDependencies}\n`}importers:
${importers}
packages:
${packages}
snapshots:
${snapshots}
`

describe('translatePnpmLock', () => {
  it('resolves aliases, peer identities, and workspace links without losing install names', () => {
    const metadata = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })

    expect(metadata.importers['packages/app']!.dependencies.alias).toEqual({
      kind: 'package',
      snapshot: 'bar@2.0.0',
    })
    expect(metadata.importers['packages/app']!.dependencies.foo).toEqual({
      kind: 'package',
      snapshot: 'foo@1.0.0(peer@3.0.0)',
    })
    expect(metadata.importers['packages/app']!.dependencies['workspace-lib']).toEqual({
      kind: 'workspace',
      path: 'packages/lib',
    })
    expect(metadata.snapshots['foo@1.0.0(peer@3.0.0)']).toMatchObject({
      package: 'foo@1.0.0',
      peerIdentities: ['peer@3.0.0'],
      virtualStoreName: 'foo@1.0.0_peer@3.0.0',
      dependencies: {
        alias: { kind: 'package', snapshot: 'bar@2.0.0' },
        peer: { kind: 'package', snapshot: 'peer@3.0.0' },
      },
    })
  })

  it('emits sorted platform metadata and stable targets', () => {
    const first = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })
    const second = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })

    expect(first).toEqual(second)
    expect(first.packages['foo@1.0.0']).toMatchObject({
      cpu: ['arm64', 'x64'],
      os: ['darwin', 'linux'],
      libc: ['glibc'],
      resolution: 'registry',
      url: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz',
    })
    expect(first.packages['foo@1.0.0']!.target).toMatch(/^package_foo_1_0_0_[a-f0-9]{12}$/)
  })

  it('uses an integrity-verified public tarball URL as its Buck archive source', async () => {
    const url = 'https://overeng-effect-utils.cachix.org/serve/abc123/overeng-utils.tgz'
    const key = `@overeng/utils@${url}`
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    dependencies:
      '@overeng/utils':
        specifier: ${url}
        version: ${url}`,
        packages: `  '${key}':
    resolution: {integrity: ${archiveIntegrity}, tarball: ${url}}
    version: 0.1.0`,
        snapshots: `  '${key}': {}`,
      }),
      workspaceText: workspace(),
    })
    expect(metadata.packages[key]).toMatchObject({
      integrity: archiveIntegrity,
      resolution: 'registry',
      url,
      version: url,
    })
    const fetched: string[] = []
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async (source) => {
        fetched.push(source)
        return archive
      },
    })
    expect(fetched).toEqual([url])
    expect(sidecar.packages[key]).toMatchObject({
      classification: 'public',
      integrity: archiveIntegrity,
      registryUrl: url,
      sha256: createHash('sha256').update(archive).digest('hex'),
    })
    const decoded = decodePnpmSha256Sidecar(JSON.parse(JSON.stringify(sidecar)))
    validatePnpmSha256Sidecar({ metadata, sidecar: decoded })
    expect(decoded).toEqual(sidecar)
    expect(renderPnpmPackageTargets({ metadata, sidecar })).toContain(`    url = ${JSON.stringify(url)},`)
    await expect(
      generatePnpmSha256Sidecar({ metadata, fetchArchive: async () => otherArchive }),
    ).rejects.toThrow('integrity')
  })

  it('still rejects unknown tarball fields and missing tarball integrity', () => {
    const url = 'https://overeng-effect-utils.cachix.org/serve/abc123/overeng-utils.tgz'
    for (const [packageFields, expectedError] of [
      [
        `    resolution: {integrity: ${archiveIntegrity}, tarball: ${url}}
    version: 0.1.0
    unrecognized: true`,
        'unsupported fields: unrecognized',
      ],
      [
        `    resolution: {tarball: ${url}}
    version: 0.1.0`,
        'resolution.integrity must be a non-empty string',
      ],
    ]) {
      expect(() =>
        translatePnpmLock({
          lockfileText: lock({
            importers: '  .: {}',
            packages: `  '@overeng/utils@${url}':
${packageFields}`,
            snapshots: `  '@overeng/utils@${url}': {}`,
          }),
          workspaceText: workspace(),
        }),
      ).toThrow(expectedError)
    }
  })

  it('includes dependency overrides in the semantic lock fingerprint', () => {
    const baseline = translatePnpmLock({ lockfileText: lock(), workspaceText: workspace() })
    const overridden = translatePnpmLock({
      lockfileText: lock({ overrides: '  foo: 1.0.0' }),
      workspaceText: workspace(),
    })

    expect(overridden.lockfileFingerprint).not.toBe(baseline.lockfileFingerprint)
  })

  it('normalizes pnpm 12 omission of disabled workspace injection', () => {
    const explicitFalse = lock().replace(
      '  injectWorkspacePackages: true\n',
      '  injectWorkspacePackages: false\n',
    )
    const omitted = lock().replace('  injectWorkspacePackages: true\n', '')
    const options = { workspaceText: workspace() }

    const explicitFalseFingerprint = translatePnpmLock({
      ...options,
      lockfileText: explicitFalse,
    }).lockfileFingerprint
    expect(
      translatePnpmLock({ ...options, lockfileText: omitted }).lockfileFingerprint,
    ).toBe(explicitFalseFingerprint)
    expect(translatePnpmLock({ ...options, lockfileText: lock() }).lockfileFingerprint).not.toBe(
      explicitFalseFingerprint,
    )
  })

  it('rejects explicit null workspace injection', () => {
    const explicitNull = lock().replace(
      '  injectWorkspacePackages: true\n',
      '  injectWorkspacePackages: null\n',
    )

    expect(() =>
      translatePnpmLock({ lockfileText: explicitNull, workspaceText: workspace() }),
    ).toThrow('pnpm-lock.yaml.settings.injectWorkspacePackages must be a boolean')
  })

  it('supports a patch only when source bytes, lock hash, and snapshot identity agree', () => {
    const patchBytes = new TextEncoder().encode('patch bytes')
    const patchHash = createHash('sha256').update(patchBytes).digest('hex')
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${patchHash})`,
        packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        patchedDependencies: `  foo@1.0.0: ${patchHash}`,
        snapshots: `  foo@1.0.0(patch_hash=${patchHash}): {}`,
      }),
      workspaceText: workspace({ patches: '  foo@1.0.0: patches/foo.patch' }),
      readPatch: (patchPath) => {
        expect(patchPath).toBe('patches/foo.patch')
        return patchBytes
      },
    })

    expect(metadata.packages['foo@1.0.0']!.patch).toEqual({
      hash: patchHash,
      path: 'patches/foo.patch',
    })
  })

  it('translates the real lock deterministically', () => {
    const options = {
      lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
      workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
    }
    const first = translatePnpmLock(options)
    const second = translatePnpmLock(options)

    expect(second).toEqual(first)
    expect(first.packages['@myobie/pty@0.10.0']!.patch?.path).toBe(
      'patches/@myobie__pty@0.10.0.patch',
    )
  })

  it('keeps every same-repo workspace dependency a live link in the real lock', () => {
    // `injectWorkspacePackages: true` lets pnpm 12 resolve a workspace
    // dependency as an injected `file:` snapshot whenever the consumer's peer
    // graph differs from the dependency's own. That copy is materialised once at
    // install time, so the consumer silently stops reading workspace source.
    // Every workspace edge in this repo must therefore stay a `link:` edge; the
    // one importer that needs an explicit opt-out declares a path-based
    // `workspace:` specifier (see packages/@overeng/restate-effect).
    const lockfileText = readFileSync('pnpm-lock.yaml', 'utf8')
    const importersSection = lockfileText.slice(
      lockfileText.indexOf('\nimporters:'),
      lockfileText.indexOf('\npackages:'),
    )

    expect(importersSection.match(/^ +version: file:.*$/gm)).toBeNull()
    expect(importersSection).toContain(
      "      '@overeng/utils':\n        specifier: workspace:../utils\n        version: link:../utils\n",
    )

    // The projection still resolves that edge to the workspace tree, so the
    // opt-out changes where pnpm reads the package from, not the Buck graph.
    const metadata = translatePnpmLock({
      lockfileText,
      workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
    })

    expect(
      metadata.importers['packages/@overeng/restate-effect']!.devDependencies['@overeng/utils'],
    ).toEqual({ kind: 'workspace', path: 'packages/@overeng/utils' })
  })

  it('resolves every OpenTUI importer against the single catalog compiler', () => {
    // `@opentui/core` peers TypeScript. An importer that does not declare the
    // peer lets pnpm satisfy it from `bun-ffi-structs`'s `^5` range, which
    // installs a second compiler and splits `@opentui/core` into two store
    // entries built against different TypeScript versions — the shape
    // `context/opentui` had before it declared the dependency.
    // The other compiler in the lock is `@overeng/oxc-config`'s deliberate
    // 5.9.3 rule-tester pin, which no OpenTUI importer may resolve against.
    const metadata = translatePnpmLock({
      lockfileText: readFileSync('pnpm-lock.yaml', 'utf8'),
      workspaceText: readFileSync('pnpm-workspace.yaml', 'utf8'),
    })

    const compilers = Object.keys(metadata.packages).filter((key) => key.startsWith('typescript@'))
    expect(compilers).toEqual(['typescript@5.9.3', 'typescript@7.0.2'])

    const openTuiCores = Object.keys(metadata.snapshots).filter((key) =>
      key.startsWith('@opentui/core@'),
    )
    expect(openTuiCores).toHaveLength(1)
    expect(openTuiCores[0]).toContain('typescript@7.0.2')

    const openTuiImporters = Object.entries(metadata.importers).filter(
      ([, importer]) =>
        '@opentui/core' in importer.dependencies === true ||
        '@opentui/core' in importer.devDependencies === true,
    )
    expect(openTuiImporters.length).toBeGreaterThan(0)
    for (const [path, importer] of openTuiImporters) {
      const declared = importer.dependencies['typescript'] ?? importer.devDependencies['typescript']
      expect(declared, `${path} must declare the catalog compiler`).toBeDefined()
    }
  })

  it('rejects malformed integrity and unsupported lifecycle builds', () => {
    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          packages: `  foo@1.0.0:
    resolution: {integrity: sha512-not-base64}`,
          snapshots: '  foo@1.0.0: {}',
          importers: '  .: {}',
        }),
        workspaceText: workspace(),
      }),
    ).toThrow(/canonical sha512 integrity/)

    expect(() =>
      translatePnpmLock({
        lockfileText: lock(),
        workspaceText: workspace({ allowBuilds: '  esbuild: true' }),
      }),
    ).toThrow(/lifecycle builds are unsupported/)

    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    requiresBuild: true`,
          snapshots: '  foo@1.0.0: {}',
          importers: '  .: {}',
        }),
        workspaceText: workspace(),
      }),
    ).toThrow(/requiresBuild is unsupported/)
  })

  it('rejects stale patches and ambiguous peer identities', () => {
    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          patchedDependencies: `  foo@1.0.0: ${'a'.repeat(64)}`,
        }),
        workspaceText: workspace({ patches: '  foo@1.0.0: patches/foo.patch' }),
        readPatch: () => new TextEncoder().encode('wrong patch'),
      }),
    ).toThrow(/hash mismatch/)

    expect(() =>
      translatePnpmLock({
        lockfileText: lock({
          packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
          snapshots: `  foo@1.0.0(peer-a@1.0.0): {}
  foo@1.0.0(peer-b@1.0.0): {}`,
          importers: `  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0`,
        }),
        workspaceText: workspace(),
      }),
    ).toThrow(/ambiguous peer identity/)
  })
})

describe('pnpm sha256 sidecar', () => {
  it('verifies sha512 before deriving sha256 and reuses integrity-matched entries', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  bar@2.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    const fetched: string[] = []
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async (url) => {
        fetched.push(url)
        return archive
      },
    })
    validatePnpmSha256Sidecar({ metadata, sidecar })
    expect(fetched).toEqual(['https://registry.npmjs.org/bar/-/bar-2.0.0.tgz'])
    expect(sidecar.packages['bar@2.0.0']).toEqual({
      bins: {},
      classification: 'public',
      integrity: archiveIntegrity,
      packageIdentity: 'bar@2.0.0',
      registryUrl: 'https://registry.npmjs.org/bar/-/bar-2.0.0.tgz',
      sha256: createHash('sha256').update(archive).digest('hex'),
      sizeBytes: archive.byteLength,
    })

    const cached = await generatePnpmSha256Sidecar({
      metadata,
      previous: sidecar,
      fetchArchive: async () => {
        throw new Error('matched cache entry must not fetch')
      },
    })
    expect(cached).toEqual(sidecar)
    expect(decodePnpmSha256Sidecar(JSON.parse(JSON.stringify(sidecar)))).toEqual(sidecar)
  })

  it('derives normalized bin metadata from an integrity-verified npm archive', async () => {
    const bytes = npmArchive({ bin: { tool: './bin/tool.js' } })
    const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  tool@1.0.0:
    resolution: {integrity: ${integrity}}
    hasBin: true`,
        snapshots: '  tool@1.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => bytes,
    })

    expect(sidecar.packages['tool@1.0.0']!.bins).toEqual({ tool: 'bin/tool.js' })
  })
  it('fails closed on downloaded integrity mismatch and stale freshness metadata', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  bar@2.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    await expect(
      generatePnpmSha256Sidecar({ metadata, fetchArchive: async () => otherArchive }),
    ).rejects.toThrow(/does not match downloaded archive/)

    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    const barArchive = sidecar.packages['bar@2.0.0']!
    expect(() =>
      assertArchiveAllowedForTier({
        archive: { ...barArchive, classification: 'private' },
        packageIdentity: 'bar@2.0.0',
        tier: 'public',
      }),
    ).toThrow(/cannot enter the public tier/)
    expect(() =>
      verifyArchive({
        archive: barArchive,
        bytes: otherArchive,
        packageIdentity: 'bar@2.0.0',
      }),
    ).toThrow(/SHA-512 mismatch/)
    expect(() =>
      validatePnpmSha256Sidecar({
        metadata,
        sidecar: { ...sidecar, lockfileFingerprint: `sha256:${'0'.repeat(64)}` },
      }),
    ).toThrow(/stale sha256 sidecar lock fingerprint/)
    expect(() =>
      validatePnpmSha256Sidecar({
        metadata,
        sidecar: { ...sidecar, packages: {} },
      }),
    ).toThrow(/stale sha256 sidecar package identity set/)
    expect(() =>
      validatePnpmSha256Sidecar({
        metadata,
        sidecar: {
          ...sidecar,
          packages: {
            ...sidecar.packages,
            'bar@2.0.0': {
              ...sidecar.packages['bar@2.0.0']!,
              registryUrl: 'https://registry.npmjs.org/bar/-/bar-9.9.9.tgz',
            },
          },
        },
      }),
    ).toThrow(/stale sha256 sidecar registry URL/)
    expect(() =>
      validatePnpmSha256Sidecar({
        metadata,
        sidecar: {
          ...sidecar,
          packages: {
            ...sidecar.packages,
            'bar@2.0.0': {
              ...sidecar.packages['bar@2.0.0']!,
              classification: 'private',
            },
          },
        },
      }),
    ).toThrow(/must be classified public/)
  })
})

describe('pnpm archive seeder', () => {
  it('verifies an existing CAS object before counting it as present', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        packages: `  bar@2.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        snapshots: '  bar@2.0.0: {}',
        importers: '  .: {}',
      }),
      workspaceText: workspace(),
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    const entry = sidecar.packages['bar@2.0.0']!
    const casUrl = `https://cas.example/cas/${entry.sha256}`
    const requests: string[] = []

    await expect(
      seedArchive({
        archive: entry,
        fetchArchive: async (input, init) => {
          requests.push(`${init?.method ?? 'GET'} ${String(input)}`)
          if (init?.method === 'HEAD') return new Response(null, { status: 200 })
          return new Response(otherArchive, { status: 200 })
        },
        headers: undefined,
        packageIdentity: 'bar@2.0.0',
        tier: 'private',
        urlPrefix: 'https://cas.example/cas/',
      }),
    ).rejects.toThrow(/lock SHA-512 mismatch/)
    expect(requests).toEqual([`HEAD ${casUrl}`, `GET ${casUrl}`])
  })

  it('resolves environment, local, tracked, and trusted origin precedence', () => {
    const trackedConfig = `[archive_origin]
  url_prefix = https://tracked.example/cas/
  tier = public
  trusted_url_prefix = https://trusted.example/cas/
  trusted_tier = private
`
    const localConfig = `[archive_origin]
  url_prefix = https://local.example/cas/
  tier = private
`

    expect(resolveArchiveOrigin({ env: {}, localConfig, trackedConfig })).toEqual({
      tier: 'private',
      urlPrefix: 'https://local.example/cas/',
    })
    expect(
      resolveArchiveOrigin({
        env: {
          BUCK2_ARCHIVE_CAS_TIER: 'public',
          BUCK2_ARCHIVE_CAS_URL: 'https://environment.example/cas/',
        },
        localConfig,
        trackedConfig,
      }),
    ).toEqual({
      tier: 'public',
      urlPrefix: 'https://environment.example/cas/',
    })
    expect(resolveArchiveOrigin({ env: {}, localConfig: '', trackedConfig })).toEqual({
      tier: 'public',
      urlPrefix: 'https://tracked.example/cas/',
    })
    expect(
      resolveArchiveOrigin({
        env: {},
        localConfig: '',
        trackedConfig: trackedConfig
          .replace('  url_prefix = https://tracked.example/cas/\n', '')
          .replace('  tier = public\n', ''),
      }),
    ).toEqual({
      tier: 'private',
      urlPrefix: 'https://trusted.example/cas/',
    })
  })
})

describe('Buck package targets', () => {
  it('renders one deterministic hash-pinned archive target per registry package', async () => {
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    optionalDependencies:
      native:
        specifier: 1.0.0
        version: 1.0.0`,
        packages: `  native@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}
    cpu: [x64]
    os: [linux]`,
        snapshots: `  native@1.0.0:
    optional: true`,
      }),
      workspaceText: workspace(),
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    const rendered = renderPnpmPackageTargets({ metadata, sidecar })

    expect(renderPnpmPackageTargets({ metadata, sidecar })).toBe(rendered)
    expect([...rendered.matchAll(/^pnpm_package\($/gm)]).toHaveLength(1)
    expect(rendered).toContain(
      `    package_name = "native",\n    url = ${JSON.stringify(metadata.packages['native@1.0.0']!.url)},`,
    )
    expect(rendered).toContain(`    size_bytes = ${archive.byteLength},`)
  })

  it('renders same-cell patch labels without a cell name', async () => {
    const patchBytes = new TextEncoder().encode('patch bytes')
    const patchHash = createHash('sha256').update(patchBytes).digest('hex')
    const metadata = translatePnpmLock({
      lockfileText: lock({
        importers: `  .:
    dependencies:
      foo:
        specifier: 1.0.0
        version: 1.0.0(patch_hash=${patchHash})`,
        packages: `  foo@1.0.0:
    resolution: {integrity: ${archiveIntegrity}}`,
        patchedDependencies: `  foo@1.0.0: ${patchHash}`,
        snapshots: `  foo@1.0.0(patch_hash=${patchHash}): {}`,
      }),
      workspaceText: workspace({ patches: '  foo@1.0.0: patches/foo.patch' }),
      readPatch: () => patchBytes,
    })
    const sidecar = await generatePnpmSha256Sidecar({
      metadata,
      fetchArchive: async () => archive,
    })
    const rendered = renderPnpmPackageTargets({ metadata, sidecar })

    expect(rendered).toContain('patches = ["//:patches/foo.patch"]')
    expect(rendered).not.toContain('effect_utils//')
  })
})
