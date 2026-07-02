import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Provenance } from './mod.ts'
import { renderRustConstants } from './mod.ts'
import { otelScrapeFixtureRegistry } from './otel-scrape.fixture.ts'

// The synthetic otel-scrape registry is authored directly as dep-free Layer-1 data
// (`renderRustConstants` renders it below — the true name-projection path).
const registry = otelScrapeFixtureRegistry

const FIXTURE_PROVENANCE: Provenance = {
  source: 'packages/@overeng/genie/src/runtime/weaver/otel-scrape.fixture.ts',
  fingerprint: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
}

// The ~25 names decision 0007 expects the Rust bindings to cover.
const EXPECTED_ATTRIBUTE_KEYS = [
  'otel_scrape.batch.size',
  'otel_scrape.compressed',
  'otel_scrape.duration_ms',
  'otel_scrape.endpoint',
  'otel_scrape.error.type',
  'otel_scrape.payload.size_bytes',
  'otel_scrape.profile.cpu_samples',
  'otel_scrape.profile.heap_bytes',
  'otel_scrape.profile.name',
  'otel_scrape.protocol',
  'otel_scrape.request.header',
  'otel_scrape.result.cached',
  'otel_scrape.retry.count',
  'otel_scrape.schema.tag',
  'otel_scrape.schema.version',
  'otel_scrape.status',
  'otel_scrape.target.name',
  'otel_scrape.target.port',
  'otel_scrape.target.url',
  'otel_scrape.tls.enabled',
] as const
const EXPECTED_SPAN_IDS = ['span.otel_scrape.batch', 'span.otel_scrape.request'] as const
const EXPECTED_METRIC_NAMES = [
  'otel_scrape.payload.bytes',
  'otel_scrape.scrape.duration',
  'otel_scrape.scrapes',
] as const
const ALL_EXPECTED_NAMES = [
  ...EXPECTED_ATTRIBUTE_KEYS,
  ...EXPECTED_SPAN_IDS,
  ...EXPECTED_METRIC_NAMES,
]

/** Resolve a binary from `$PATH` (rust tooling is provided by devenv/CI, absent in some sandboxes). */
const onPath = (bin: string): string | undefined => {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, bin)
    if (existsSync(candidate) === true) return candidate
  }
  return undefined
}

describe('renderRustConstants (otel-scrape fixture)', () => {
  const rust = renderRustConstants({ registry, provenance: FIXTURE_PROVENANCE })

  it('is deterministic (render twice = byte-identical)', () => {
    const again = renderRustConstants({ registry, provenance: FIXTURE_PROVENANCE })
    expect(again).toBe(rust)
  })

  it('covers all ~25 otel-scrape names as Rust string-literal constants', () => {
    // Every expected name appears as a `= "<name>";` const value.
    for (const name of ALL_EXPECTED_NAMES) {
      expect(rust).toContain(`= ${JSON.stringify(name)};`)
    }
    expect(ALL_EXPECTED_NAMES.length).toBe(25)

    // Each kind is projected into its own module (collision-proof by construction).
    expect(rust).toContain('pub mod attribute {')
    expect(rust).toContain('pub mod span {')
    expect(rust).toContain('pub mod metric {')

    // Const count per kind matches the fixture exactly.
    const constCount = (moduleName: string): number => {
      const start = rust.indexOf(`pub mod ${moduleName} {`)
      const end = rust.indexOf('\n}', start)
      const body = rust.slice(start, end)
      return [...body.matchAll(/pub const [A-Z0-9_]+: &str =/g)].length
    }
    expect(constCount('attribute')).toBe(EXPECTED_ATTRIBUTE_KEYS.length)
    expect(constCount('span')).toBe(EXPECTED_SPAN_IDS.length)
    expect(constCount('metric')).toBe(EXPECTED_METRIC_NAMES.length)
  })

  it('carries the provenance header (registry-source + fingerprint)', () => {
    expect(rust.startsWith(`// registry-source: ${FIXTURE_PROVENANCE.source}\n`)).toBe(true)
    expect(rust).toContain(`// fingerprint: ${FIXTURE_PROVENANCE.fingerprint}`)
  })

  const rustfmt = onPath('rustfmt')
  it.runIf(rustfmt !== undefined)('is rustfmt-clean', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weaver-rust-'))
    const file = path.join(dir, 'constants.rs')
    writeFileSync(file, rust)
    const res = spawnSync(rustfmt as string, ['--check', file], { encoding: 'utf8' })
    expect(res.stderr + res.stdout).toBe('')
    expect(res.status).toBe(0)
  })

  const rustc = onPath('rustc')
  it.runIf(rustc !== undefined)('compiles as valid Rust (rustc --emit=metadata)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'weaver-rust-'))
    const file = path.join(dir, 'constants.rs')
    writeFileSync(file, rust)
    const res = spawnSync(
      rustc as string,
      ['--emit=metadata', '--crate-type', 'lib', file, '-o', path.join(dir, 'out.rmeta')],
      { encoding: 'utf8' },
    )
    expect(res.stderr).toBe('')
    expect(res.status).toBe(0)
  })
})
