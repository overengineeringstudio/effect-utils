import { readFileSync } from 'node:fs'

import { buck2SemanticFingerprint } from '../../genie/buck2/mod.ts'
import { createGenieOutput } from '../../packages/@overeng/genie/src/runtime/core.ts'

const data = { name: 'smoke', src: 'smoke.mjs', visibility: ['PUBLIC'] }
const fingerprint = buck2SemanticFingerprint({
  generator: 'effect-utils/rust/interop-smoke-fixture',
  schemaVersion: 1,
  semanticData: { data, source: readFileSync(new URL(import.meta.url), 'utf8') },
})

export default createGenieOutput({
  data,
  stringify: () =>
    [
      '# Projection source: rust/effect-rust-fixtures/BUCK.genie.ts',
      `# Semantic fingerprint: ${fingerprint}`,
      '# Semantic inputs: rust/effect-rust-fixtures/BUCK.genie.ts',
      '# Regenerate: devenv tasks run genie:run',
      '',
      'load("//buck2:materialization.bzl", "package_view")',
      'load("//buck2:typescript.bzl", "tsgo_typecheck")',
      '',
      // Reuse the package's normalized closure and real emitted declarations, not
      // a fixture-local install or copied ambient workspace node_modules.
      'package_view(',
      '    name = "package_tree",',
      '    dependency_view = "//packages/@overeng/effect-rust:node_modules",',
      '    files = {source: source for source in glob(["**/*.ts"], exclude = ["**/*.genie.ts"]) + ["tsconfig.json"]},',
      '    workspace_dist = {',
      '        "node_modules/@overeng/effect-rust/dist": "//packages/@overeng/effect-rust:dist",',
      '        "node_modules/@overeng/effect-rust/package.json": "//packages/@overeng/effect-rust:package.json",',
      '    },',
      '    generated_dependencies = {',
      '        "effect-rust-fixture": "//rust/effect-rust-fixtures/service:service",',
      '    },',
      '    workspace_dependency_views = {',
      '        "node_modules/@overeng/effect-rust/node_modules": "//packages/@overeng/effect-rust:package_tree",',
      '    },',
      '    runtime = "//packages/@overeng/buck2-tools:package_tree_runtime",',
      '    runtime_entry = "package-tree.ts",',
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      'tsgo_typecheck(',
      '    name = "typecheck",',
      '    package_tree = ":package_tree",',
      '    visibility = ["PUBLIC"],',
      ')',
      '',
      'export_file(',
      `    name = ${JSON.stringify(data.name)},`,
      `    src = ${JSON.stringify(data.src)},`,
      `    visibility = ${JSON.stringify(data.visibility)},`,
      ')',
      '',
      'export_file(name = "service-smoke", src = "service-smoke.ts", visibility = ["PUBLIC"])',
      'export_file(name = "wasm-scheduler-smoke", src = "wasm-scheduler-smoke.ts", visibility = ["PUBLIC"])',
      'export_file(name = "browser-smoke", src = "browser-smoke.mjs", visibility = ["PUBLIC"])',
      'export_file(name = "browser-smoke-server", src = "browser-smoke-server.mjs", visibility = ["PUBLIC"])',
      'export_file(name = "workerd-smoke", src = "workerd-smoke.mjs", visibility = ["PUBLIC"])',
      'export_file(name = "workerd-smoke-config", src = "workerd-smoke-config.mjs", visibility = ["PUBLIC"])',
      '',
    ].join('\n'),
})
