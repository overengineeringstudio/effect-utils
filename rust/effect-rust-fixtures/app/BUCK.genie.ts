import { readFileSync } from 'node:fs'

import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import { createGenieOutput } from '../../../packages/@overeng/genie/src/runtime/core.ts'

// The eager group links into the app's initial bundle; `lazy` becomes its own wasm behind a dynamic import.
const manifest = { eager: ['hash_core'], lazy: ['math_core'] }
const runtimes = ['node', 'bun'] as const
// App inputs list adapter crates only. Export signatures live in Rust macro manifests.
const crates = {
  hash_core: '//rust/effect-rust-fixtures/hash-interop:lib',
  math_core: '//rust/effect-rust-fixtures/math-interop:lib',
}
const generator = 'effect-utils/rust/wasm-aggregator-fixture'
const fingerprint = buck2SemanticFingerprint({
  generator,
  schemaVersion: 1,
  semanticData: { manifest, crates, source: readFileSync(new URL(import.meta.url), 'utf8') },
})
const dict = (value: unknown): string => JSON.stringify(value, undefined, 4)

export default createGenieOutput({
  data: { manifest, crates },
  stringify: () => [
    '# Projection source: rust/effect-rust-fixtures/app/BUCK.genie.ts',
    `# Projection generator: ${generator}`,
    '# Projection schema version: 1',
    `# Semantic fingerprint: ${fingerprint}`,
    '# Semantic inputs: rust/effect-rust-fixtures/app/BUCK.genie.ts',
    '# Regenerate: devenv tasks run genie:run',
    '',
    'load("//buck2/rust:interop.bzl", "rust_interop_smoke", "rust_wasm_aggregator")',
    '',
    'rust_wasm_aggregator(',
    '    name = "app",',
    `    manifest = ${dict(manifest)},`,
    `    crates = ${dict(crates)},`,
    ')',
    '',
    ...runtimes.flatMap((runtime) => [
      'rust_interop_smoke(',
      `    name = "app-smoke-${runtime}",`,
      '    product = ":app",',
      `    runtime = "${runtime}",`,
      '    script = "//rust/effect-rust-fixtures:smoke",',
      ')',
      '',
    ]),
  ].join('\n'),
})
