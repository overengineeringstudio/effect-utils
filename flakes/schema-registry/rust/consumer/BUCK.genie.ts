import { cargoWorkspaceProjection } from '../../../../genie/buck2/cargo-projection.ts'

export default cargoWorkspaceProjection({
  workspaceRoot: 'flakes/agent-trace/rust',
  memberPaths: ['.', '../../schema-registry/rust', '../../schema-registry/rust/consumer'],
})({
  buildScriptInputs: [
    { path: 'flakes/schema-registry/rust/consumer/cases.schema.json' },
    { path: 'flakes/schema-registry/rust/consumer/receipt.schema.json' },
    {
      path: 'flakes/agent-trace/generated/AgentTraceRuntimeV1.rs',
      label: '//flakes/agent-trace:AgentTraceRuntimeV1.rs',
    },
  ],
  sourceUrl: import.meta.url,
})
