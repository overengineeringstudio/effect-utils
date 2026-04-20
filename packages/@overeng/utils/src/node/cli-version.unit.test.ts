import { beforeEach, describe, expect, it } from 'vitest'

import { resolveCliBuildIdentity } from './cli-build-identity.ts'

describe('cli-build-identity', () => {
  beforeEach(() => {
    delete process.env['CLI_BUILD_STAMP']
  })

  it('falls back to the base package version when no build stamp is available', () => {
    expect(
      resolveCliBuildIdentity({
        baseVersion: '0.1.0',
        buildStamp: '__CLI_BUILD_STAMP__',
      }),
    ).toEqual({
      baseVersion: '0.1.0',
      machineVersion: '0.1.0',
      displayVersion: '0.1.0',
      sourceKind: 'package',
      dirty: false,
    })
  })

  it('derives local source identity from CLI_BUILD_STAMP', () => {
    process.env['CLI_BUILD_STAMP'] = JSON.stringify({
      type: 'local',
      rev: 'abc123',
      ts: 1_700_000_000,
      dirty: true,
    })

    const resolved = resolveCliBuildIdentity({
      baseVersion: '0.1.0',
      buildStamp: '__CLI_BUILD_STAMP__',
    })

    expect(resolved.baseVersion).toBe('0.1.0')
    expect(resolved.machineVersion).toBe('0.1.0+local.abc123.dirty')
    expect(resolved.sourceKind).toBe('local')
    expect(resolved.rev).toBe('abc123')
    expect(resolved.dirty).toBe(true)
    expect(resolved.buildTs).toBe(1_700_000_000)
    expect(resolved.displayVersion).toContain('0.1.0')
    expect(resolved.displayVersion).toContain('running from local source')
  })

  it('prefers an embedded nix stamp over the runtime environment stamp', () => {
    process.env['CLI_BUILD_STAMP'] = JSON.stringify({
      type: 'local',
      rev: 'ignored',
      ts: 1_700_000_000,
      dirty: false,
    })

    const nixStamp = JSON.stringify({
      type: 'nix',
      version: '0.1.0',
      rev: 'def456',
      commitTs: 1_700_000_000,
      dirty: false,
    })

    const resolved = resolveCliBuildIdentity({
      baseVersion: '0.1.0',
      buildStamp: nixStamp,
    })

    expect(resolved).toMatchObject({
      baseVersion: '0.1.0',
      machineVersion: '0.1.0+def456',
      sourceKind: 'nix',
      rev: 'def456',
      dirty: false,
      commitTs: 1_700_000_000,
    })
    expect(resolved.displayVersion).toContain('0.1.0+def456')
  })
})
