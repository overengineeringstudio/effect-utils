import { readFileSync } from 'node:fs'

import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import { createGenieOutput } from '../../../packages/@overeng/genie/src/runtime/core.ts'

// The eager group links into the app's initial bundle; `lazy` becomes its own wasm behind a dynamic import.
const manifest = { eager: ['hash_core'], lazy: ['math_core'] }
const runtimes = ['node', 'bun'] as const
const cores = {
  hash_core: {
    crate: '//rust/effect-rust-fixtures/hash-core:lib',
    exports: {
      sha256Hex: {
        args: 'input: &[u8]',
        returns: 'String',
        expression: 'hash_core::sha256_hex(input)',
      },
    },
  },
  math_core: {
    crate: '//rust/effect-rust-fixtures/math-core:lib',
    exports: {
      add: {
        args: 'left: i32, right: i32',
        returns: 'i32',
        expression: 'math_core::add(left, right)',
      },
    },
  },
}
const generator = 'effect-utils/rust/wasm-aggregator-fixture'
const fingerprint = buck2SemanticFingerprint({
  generator,
  schemaVersion: 1,
  semanticData: { manifest, cores, source: readFileSync(new URL(import.meta.url), 'utf8') },
})
const dict = (value: unknown): string => JSON.stringify(value, undefined, 4)

export default createGenieOutput({
  data: { manifest, cores },
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
    `    cores = ${dict(cores)},`,
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
