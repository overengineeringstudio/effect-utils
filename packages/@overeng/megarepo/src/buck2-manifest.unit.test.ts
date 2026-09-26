import { describe, it } from '@effect/vitest'
import { expect } from 'vitest'

import {
  BUCK_MEMBER_MANIFEST_SCHEMA_VERSION,
  decodeBuckMemberManifest,
  decodeBuckMemberManifestJson,
  encodeBuckMemberManifestJson,
  type BuckMemberCapability,
  type BuckMemberManifest,
  type BuckMemberToolchainAuthority,
} from '@overeng/megarepo/buck2-manifest'

const buck2: BuckMemberCapability = {
  toolId: 'buck2',
  protocol: 'facebook/buck2-cli/2026-08-22',
  flakePackage: 'buck2',
  executable: 'bin/buck2',
}

const tsgo: BuckMemberCapability = {
  toolId: 'effect-tsgo',
  protocol: 'effect-utils/buck2-effect-tsgo/v1',
  flakePackage: 'effect-tsgo',
  executable: 'bin/tsgo',
}

const tsgoAuthority: BuckMemberToolchainAuthority = {
  _tag: 'ToolchainAuthority',
  toolchain: 'tsgo',
  provides: [tsgo],
}

const manifest: BuckMemberManifest = {
  schemaVersion: BUCK_MEMBER_MANIFEST_SCHEMA_VERSION,
  capabilities: [tsgoAuthority, buck2],
}

describe('@overeng/megarepo/buck2-manifest', () => {
  it('round-trips through canonical JSON with executables ordered before authorities', () => {
    const decoded = decodeBuckMemberManifest(manifest)
    expect(decoded.capabilities).toEqual([buck2, tsgoAuthority])
    expect(decodeBuckMemberManifestJson(encodeBuckMemberManifestJson(decoded))).toEqual(decoded)
  })

  it('projects unknown top-level fields from other manifest writers', () => {
    const decoded = decodeBuckMemberManifest({ ...manifest, cell: 'effect_utils' })
    expect(encodeBuckMemberManifestJson(decoded)).not.toContain('cell')
  })

  it('refuses a tool id provided both directly and by a toolchain authority', () => {
    expect(() =>
      decodeBuckMemberManifest({ ...manifest, capabilities: [tsgoAuthority, tsgo] }),
    ).toThrow('Duplicate capability toolId: effect-tsgo')
  })
})
