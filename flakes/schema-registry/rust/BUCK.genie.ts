import { cargoWorkspaceProjection } from '../../../genie/buck2/cargo-projection.ts'

export default cargoWorkspaceProjection({
  workspaceRoot: 'flakes/agent-trace/rust',
  memberPaths: ['.', '../../schema-registry/rust', '../../schema-registry/rust/consumer'],
})({ sourceUrl: import.meta.url })
