import { cargoWorkspaceProjection } from '../../../genie/buck2/cargo-projection.ts'
import { agentTraceSchemaBuildInputs } from './schema-inputs.ts'

export default cargoWorkspaceProjection({
  workspaceRoot: 'flakes/agent-trace/rust',
  memberPaths: ['.', '../../schema-registry/rust', '../../schema-registry/rust/consumer'],
  generatorSourcePaths: ['flakes/agent-trace/rust/schema-inputs.ts'],
})({
  buildProduct: true,
  buildScriptInputs: agentTraceSchemaBuildInputs,
  sourceUrl: import.meta.url,
})
