import { readFileSync } from 'node:fs'

import { buck2SemanticFingerprint } from '../../../genie/buck2/mod.ts'
import { createGenieOutput } from '../../../packages/@overeng/genie/src/runtime/core.ts'

// One generated Effect service class for the fixture adapter crate, fed by both of its products.
const data = {
  name: 'service',
  service: 'EffectRustFixture',
  packageName: 'effect-rust-fixture',
  wasm: '//rust/effect-rust-fixtures/wasm-adapter:wasm',
  napi: '//rust/effect-rust-fixtures/napi-adapter:napi',
}
const generator = 'effect-utils/rust/interop-service-fixture'
const fingerprint = buck2SemanticFingerprint({
  generator,
  schemaVersion: 1,
  semanticData: { data, source: readFileSync(new URL(import.meta.url), 'utf8') },
})

export default createGenieOutput({
  data,
  stringify: () =>
    [
      '# Projection source: rust/effect-rust-fixtures/service/BUCK.genie.ts',
      `# Projection generator: ${generator}`,
      '# Projection schema version: 1',
      `# Semantic fingerprint: ${fingerprint}`,
      '# Semantic inputs: rust/effect-rust-fixtures/service/BUCK.genie.ts',
      '# Regenerate: devenv tasks run genie:run',
      '',
      'load("//buck2/rust:interop.bzl", "rust_interop_service", "rust_interop_service_smoke")',
      '',
      'rust_interop_service(',
      `    name = ${JSON.stringify(data.name)},`,
      `    service = ${JSON.stringify(data.service)},`,
      `    package_name = ${JSON.stringify(data.packageName)},`,
      `    wasm = ${JSON.stringify(data.wasm)},`,
      `    napi = ${JSON.stringify(data.napi)},`,
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      ...['node', 'bun'].flatMap((runtime) => [
        'rust_interop_service_smoke(',
        `    name = "service-smoke-${runtime}",`,
        '    service = ":service",',
        `    runtime = "${runtime}",`,
        '    script = "//rust/effect-rust-fixtures:service-smoke",',
        '    vectors = "//rust/effect-rust-fixtures/math-interop:vectors",',
        '    visibility = ["PUBLIC"],',
        ')',
        '',
      ]),
      '',
    ].join('\n'),
})
