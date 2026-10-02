import { readFileSync } from 'node:fs'

import { buck2SemanticFingerprint } from '../../genie/buck2/mod.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

const data = {
  service: 'ContentAddressCore',
  packageName: 'content-address-core-service',
  crate: '//rust/content-address-interop:lib',
}
const generator = 'effect-utils/rust/content-address-service'
const fingerprint = buck2SemanticFingerprint({
  generator,
  schemaVersion: 1,
  semanticData: { data, source: readFileSync(new URL(import.meta.url), 'utf8') },
})

/** Generates the byte-engine products, owned Effect service, and executable smoke receipts. */
export default createGenieOutput({
  data,
  stringify: () =>
    [
      '# Projection source: rust/content-address-service/BUCK.genie.ts',
      `# Projection generator: ${generator}`,
      '# Projection schema version: 1',
      `# Semantic fingerprint: ${fingerprint}`,
      '# Semantic inputs: rust/content-address-service/BUCK.genie.ts',
      '# Regenerate: devenv tasks run genie:run',
      '',
      'load("@prelude//:prelude.bzl", "native")',
      'load("//buck2/rust:interop.bzl", "rust_wasm_bindgen_library", "rust_napi_library", "rust_interop_service", "rust_interop_service_smoke")',
      'load("//buck2/rust:content-address-parity.bzl", "content_address_parity")',
      '',
      'native.export_file(',
      '    name = "smoke",',
      '    src = "interop-smoke.ts",',
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      'rust_wasm_bindgen_library(',
      '    name = "wasm",',
      `    crate = ${JSON.stringify(data.crate)},`,
      '    out_name = "content_address_core",',
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      'rust_napi_library(',
      '    name = "napi",',
      `    crate = ${JSON.stringify(data.crate)},`,
      '    out_name = "content_address_core",',
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      'rust_interop_service(',
      '    name = "service",',
      `    service = ${JSON.stringify(data.service)},`,
      `    package_name = ${JSON.stringify(data.packageName)},`,
      '    wasm = ":wasm",',
      '    napi = ":napi",',
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      ...['node', 'bun'].flatMap((runtime) => [
        'rust_interop_service_smoke(',
        `    name = "service-smoke-${runtime}",`,
        '    service = ":service",',
        `    runtime = "${runtime}",`,
        '    script = ":smoke",',
        '    vectors = "//rust/content-address-contract:contract-schema",',
        '    visibility = ["PUBLIC"],',
        ')',
        '',
      ]),
      ...['node', 'bun'].flatMap((runtime) => [
        'content_address_parity(',
        `    name = "engine-parity-${runtime}",`,
        '    package_tree = "//packages/@overeng/content-address:package_tree",',
        '    dist = "//packages/@overeng/content-address:dist",',
        '    service = ":service",',
        `    runtime = "${runtime}",`,
        '    visibility = ["PUBLIC"],',
        ')',
        '',
      ]),
    ].join('\n'),
})
