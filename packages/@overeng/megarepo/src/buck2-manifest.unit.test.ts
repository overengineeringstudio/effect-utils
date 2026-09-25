import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  BuckMemberManifestSchema,
  BuckMemberRemoteCacheSchema,
  COMPOSITION_ROOT_SCHEMA_VERSION,
  buckMemberCapabilityByToolId,
  buckMemberProjectedCapabilities,
  buckMemberRemoteCacheSections,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifest,
  encodeBuckMemberManifestJson,
  normalizeBuckMemberManifest,
  type BuckMemberCapability,
  type BuckMemberDistOverlay,
  type BuckMemberManifest,
  type BuckMemberRemoteCache,
  type BuckMemberToolchainAuthority,
  type BuckMemberToolchainRequirement,
} from '@overeng/megarepo/buck2-manifest'

const capability: BuckMemberCapability = {
  toolId: 'buck2',
  protocol: 'facebook/buck2-cli/2026-08-22',
  flakePackage: 'buck2',
  executable: 'bin/buck2',
}

const tsgoCapability: BuckMemberCapability = {
  toolId: 'effect-tsgo',
  protocol: 'effect-utils/buck2-effect-tsgo/v1',
  flakePackage: 'effect-tsgo',
  executable: 'bin/tsgo',
}

const toolchainAuthority: BuckMemberToolchainAuthority = {
  _tag: 'ToolchainAuthority',
  toolchain: 'tsgo',
  provides: [tsgoCapability],
}

const toolchainRequirement: BuckMemberToolchainRequirement = {
  _tag: 'ToolchainRequirement',
  toolchain: 'tsgo',
}

const overlay: BuckMemberDistOverlay = {
  target: '//packages/app:dist',
  destination: 'packages/app/dist',
}

const remoteCache: BuckMemberRemoteCache = {
  endpoint: 'grpc://cache.example.com:8443',
  instanceName: 'effect-utils',
  tls: true,
}

const manifest: BuckMemberManifest = {
  schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
  cell: 'effect_utils',
  mount: 'repos/effect-utils',
  remoteCache,
  projectIgnore: ['target', '**/dist', 'target'],
  distOverlays: [overlay],
  capabilities: [capability, toolchainAuthority, toolchainRequirement],
}

describe('@overeng/megarepo/buck2-manifest', () => {
  it('resolves the stable member-manifest schema and codec surface', () => {
    expect(BUCK_MEMBER_MANIFEST_FILENAME).toBe('buck2-member.json')
    expect(BuckMemberManifestSchema).toBeDefined()
    expect(BuckMemberRemoteCacheSchema).toBeDefined()

    const decoded = decodeBuckMemberManifest(manifest)
    expect(decoded).toEqual({
      ...manifest,
      projectIgnore: ['**/dist', 'target'],
    })
    expect(normalizeBuckMemberManifest(manifest)).toEqual(decoded)
    const encodedManifest = encodeBuckMemberManifest(decoded)
    const encodedManifestJson = encodeBuckMemberManifestJson(decoded)
    expect(encodedManifest).toEqual(decoded)
    expect(decodeBuckMemberManifestJson(encodedManifestJson)).toEqual(decoded)
    expect(encodedManifestJson).not.toContain('authorization')
    expect(encodedManifestJson).not.toContain('http_headers')
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'buck2' })).toEqual(capability)
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'tsgo' })).toBeUndefined()
    expect(buckMemberProjectedCapabilities(decoded)).toEqual([capability, tsgoCapability])
    expect(decoded.remoteCache).toEqual(remoteCache)
    expect(buckMemberRemoteCacheSections(remoteCache)).toEqual([
      {
        section: 'buck2',
        entries: [
          { key: 'allow_cache_uploads', value: 'false' },
          { key: 'digest_algorithms', value: 'SHA256' },
        ],
      },
      {
        section: 'buck2_re_client',
        entries: [
          { key: 'action_cache_address', value: 'grpc://cache.example.com:8443' },
          { key: 'cas_address', value: 'grpc://cache.example.com:8443' },
          { key: 'engine_address', value: 'grpc://cache.example.com:8443' },
          { key: 'instance_name', value: 'effect-utils' },
          { key: 'tls', value: 'true' },
        ],
      },
    ])
  })

  it('projects unknown top-level fields from newer member manifests', () => {
    const decoded = decodeBuckMemberManifest({
      ...manifest,
      newerProjection: { enabled: true },
    })

    expect(decoded).toEqual({
      ...manifest,
      projectIgnore: ['**/dist', 'target'],
    })
    expect(encodeBuckMemberManifestJson(decoded)).not.toContain('newerProjection')
  })
})
