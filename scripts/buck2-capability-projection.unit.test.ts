import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'

import {
  type CapabilityProjectionManifest,
  capabilityManifestDigest,
  computeCapabilityProjectionGeneration,
  makeCapabilityProjectionManifest,
  renderCapabilityProjectionDefs,
} from '../packages/@overeng/megarepo/src/buck2-capabilities/capability-projection.ts'

const manifest = (toolId: string, version = 'one') =>
  makeCapabilityProjectionManifest({
    platform: 'x86_64-linux',
    resolved: {
      kind: 'executable',
      capability: {
        toolId,
        protocol: 'fixture/v1',
        flakePackage: toolId,
        executable: `bin/${toolId}`,
      },
      nixOutputPath: `/nix/store/${version}-${toolId}`,
      executablePath: `/nix/store/${version}-${toolId}/bin/${toolId}`,
      executableDigest: `sha256:${'a'.repeat(64)}`,
      closureStorePaths: [`/nix/store/${version}-${toolId}`],
    },
  })

const generation = (manifests: CapabilityProjectionManifest[]) =>
  computeCapabilityProjectionGeneration(
    manifests.map((value) => ({
      path: `x86_64-linux/${value.toolId}/manifest.json`,
      bytes: `${JSON.stringify(value)}\n`,
    })),
  )

describe('per-tool capability artifact identity', () => {
  it('hashes exact manifest bytes, including the newline', () => {
    const value = manifest('selected')
    expect(capabilityManifestDigest(value)).toBe(
      createHash('sha256')
        .update(`${JSON.stringify(value)}\n`)
        .digest('hex'),
    )
    expect(capabilityManifestDigest(value)).not.toBe(
      createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    )
  })

  it('changes the analysis generation without changing unrelated tool identities', () => {
    const selected = manifest('selected')
    const other = manifest('other')
    const changed = manifest('selected', 'two')
    expect(generation([selected, other])).not.toBe(generation([changed, other]))
    expect(capabilityManifestDigest(selected)).not.toBe(capabilityManifestDigest(changed))
    expect(capabilityManifestDigest(other)).toBe(capabilityManifestDigest(manifest('other')))
    const before = renderCapabilityProjectionDefs({
      generation: generation([selected, other]),
      platform: 'x86_64-linux',
      manifests: [selected, other],
    })
    const after = renderCapabilityProjectionDefs({
      generation: generation([changed, other]),
      platform: 'x86_64-linux',
      manifests: [changed, other],
    })
    for (const defs of [before, after]) {
      expect(defs).toContain(`"manifestDigest": "${capabilityManifestDigest(other)}"`)
      expect(defs).not.toContain('generations/')
    }
  })

  it('includes runtime closure and protocol changes even when executable bytes are identical', () => {
    const value = manifest('selected')
    expect(capabilityManifestDigest({ ...value, protocol: 'fixture/v2' })).not.toBe(
      capabilityManifestDigest(value),
    )
    expect(
      capabilityManifestDigest({
        ...value,
        closureStorePaths: [...value.closureStorePaths, '/nix/store/runtime'],
      }),
    ).not.toBe(capabilityManifestDigest(value))
  })

  it('does not key a tool by its position in the projection', () => {
    const selected = manifest('selected')
    const other = manifest('other')
    expect(generation([selected, other])).toBe(generation([other, selected]))
  })
})
