import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_FILENAME,
  BuckMemberManifestSchema,
  COMPOSITION_ROOT_SCHEMA_VERSION,
  buckMemberCapabilityByToolId,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifest,
  encodeBuckMemberManifestJson,
  normalizeBuckMemberManifest,
  type BuckMemberCapability,
  type BuckMemberDistOverlay,
  type BuckMemberManifest,
  type BuckMemberToolchainAuthority,
  type BuckMemberToolchainRequirement,
} from '@overeng/megarepo/buck2-manifest'

const capability: BuckMemberCapability = {
  toolId: 'buck2',
  protocol: 'facebook/buck2-cli/2026-08-22',
  flakePackage: 'buck2',
  executable: 'bin/buck2',
}

const toolchainAuthority: BuckMemberToolchainAuthority = {
  _tag: 'ToolchainAuthority',
  toolchain: 'tsgo',
}

const toolchainRequirement: BuckMemberToolchainRequirement = {
  _tag: 'ToolchainRequirement',
  toolchain: 'tsgo',
}

const overlay: BuckMemberDistOverlay = {
  target: '//packages/app:dist',
  destination: 'packages/app/dist',
}

const manifest: BuckMemberManifest = {
  schemaVersion: COMPOSITION_ROOT_SCHEMA_VERSION,
  cell: 'effect_utils',
  mount: 'repos/effect-utils',
  projectIgnore: ['target', '**/dist', 'target'],
  distOverlays: [overlay],
  capabilities: [capability, toolchainAuthority, toolchainRequirement],
}

describe('@overeng/megarepo/buck2-manifest', () => {
  it('resolves the stable member-manifest schema and codec surface', () => {
    expect(BUCK_MEMBER_MANIFEST_FILENAME).toBe('buck2-member.json')
    expect(BuckMemberManifestSchema).toBeDefined()

    const decoded = decodeBuckMemberManifest(manifest)
    expect(decoded).toEqual({
      ...manifest,
      projectIgnore: ['**/dist', 'target'],
    })
    expect(normalizeBuckMemberManifest(manifest)).toEqual(decoded)
    expect(encodeBuckMemberManifest(decoded)).toEqual(decoded)
    expect(decodeBuckMemberManifestJson(encodeBuckMemberManifestJson(decoded))).toEqual(decoded)
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'buck2' })).toEqual(capability)
    expect(buckMemberCapabilityByToolId({ manifest: decoded, toolId: 'tsgo' })).toBeUndefined()
  })
})
