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
      'export_file(',
      `    name = ${JSON.stringify(data.name)},`,
      `    src = ${JSON.stringify(data.src)},`,
      `    visibility = ${JSON.stringify(data.visibility)},`,
      ')',
      '',
      'export_file(name = "service-smoke", src = "service-smoke.ts", visibility = ["PUBLIC"])',
      'export_file(name = "wasm-scheduler-smoke", src = "wasm-scheduler-smoke.ts", visibility = ["PUBLIC"])',
      '',
    ].join('\n'),
})
