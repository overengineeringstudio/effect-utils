import { describe, expect, it } from 'bun:test'

import { namespaceRunner } from './setup.ts'
import testPlatforms from './test-platforms.json' with { type: 'json' }

describe('namespaceRunner', () => {
  it('appends run-id affinity to runner profiles, including matrix-selected profiles', () => {
    expect(namespaceRunner({ profile: 'namespace-profile-linux-x86-64', runId: '42' })).toEqual([
      'namespace-profile-linux-x86-64;github.run-id=42',
    ])
    expect(
      namespaceRunner({ profile: '${{ matrix.runner }}', runId: '${{ github.run_id }}' }),
    ).toEqual(['${{ matrix.runner }};github.run-id=${{ github.run_id }}'])
  })

  it('keeps the separate features label for -with-features machine labels', () => {
    expect(
      namespaceRunner({ profile: 'nscloud-ubuntu-24.04-amd64-16x64-with-features', runId: '42' }),
    ).toEqual([
      'nscloud-ubuntu-24.04-amd64-16x64-with-features',
      'namespace-features:github.run-id=42',
    ])
  })
})

describe('required platform test classification', () => {
  it('declares disjoint suites with a host-behavior rationale', () => {
    const authority: Readonly<
      Record<'darwin' | 'neutral', readonly { readonly task: string; readonly rationale: string }[]>
    > = testPlatforms
    const suites = [...authority.darwin, ...authority.neutral]
    expect(new Set(suites.map(({ task }) => task)).size).toBe(suites.length)
    expect(suites.every(({ rationale }) => rationale.trim().length > 0)).toBe(true)
    expect(authority.darwin.map(({ task }) => task)).toContain('test:buck2:unit')
    expect(authority.darwin.map(({ task }) => task)).toContain('test:run')
    expect(authority.darwin).toHaveLength(18)
    expect(authority.neutral.map(({ task }) => task)).toContain(
      'test:agent-session-ingest:unbounded',
    )
    for (const task of [
      'test:genie:unbounded',
      'test:restate-effect:unbounded',
      'test:ci-tools:unbounded',
      'test:ci-tools:test_pipeline_report_local_api:unbounded',
      'test:utils-dev:unbounded',
      'test:otel-contract:unbounded',
      'test:notion-datasource-sync:unbounded',
      'test:notion-md:unbounded',
      'test:notion-cli:unbounded',
      'test:tui-stories:unbounded',
    ]) {
      expect(authority.darwin.map(({ task }) => task)).toContain(task)
    }
  })
})
