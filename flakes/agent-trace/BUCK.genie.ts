import { createGenieOutput } from '../../repos/effect-utils/packages/@overeng/genie/src/runtime/core.ts'
import { agentTraceSchemaBuildInputs } from './rust/schema-inputs.ts'

const exports = [
  ...agentTraceSchemaBuildInputs.map(({ path, label }) => ({
    name: label.slice(label.indexOf(':') + 1),
    src: path.slice('flakes/agent-trace/'.length),
  })),
  { name: 'codec-corpus.json', src: 'fixtures/codec-corpus.json' },
  { name: 'AgentTraceRuntimeV1.rs', src: 'generated/AgentTraceRuntimeV1.rs' },
]

export default createGenieOutput({
  data: exports,
  stringify: () =>
    [
      '# Generated from BUCK.genie.ts and rust/schema-inputs.ts; do not edit.',
      '# The Rust build consumes committed authority outputs, never the TypeScript generator.',
      ...exports.map(
        ({ name, src }) =>
          `export_file(\n    name = ${JSON.stringify(name)},\n    src = ${JSON.stringify(src)},\n    visibility = ["PUBLIC"],\n)\n`,
      ),
    ].join('\n') + '\n',
})
