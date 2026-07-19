import effectSocketTsconfig from '../context/effect/socket/tsconfig.json.genie.ts'
import opentuiTsconfig from '../context/opentui/tsconfig.json.genie.ts'
import { rootWorkspacePackages } from '../package.json.genie.ts'
import agentSessionIngestTsconfig from '../packages/@overeng/agent-session-ingest/tsconfig.json.genie.ts'
import ciToolsTsconfig from '../packages/@overeng/ci-tools/tsconfig.json.genie.ts'
import contentAddressTsconfig from '../packages/@overeng/content-address/tsconfig.json.genie.ts'
import effectAiClaudeCliTsconfig from '../packages/@overeng/effect-ai-claude-cli/tsconfig.json.genie.ts'
import effectDistributedLockTsconfig from '../packages/@overeng/effect-distributed-lock/tsconfig.json.genie.ts'
import effectPathTsconfig from '../packages/@overeng/effect-path/tsconfig.json.genie.ts'
import effectReactTsconfig from '../packages/@overeng/effect-react/tsconfig.json.genie.ts'
import effectRpcTanstackBasicTsconfig from '../packages/@overeng/effect-rpc-tanstack/examples/basic/tsconfig.json.genie.ts'
import effectRpcTanstackTsconfig from '../packages/@overeng/effect-rpc-tanstack/tsconfig.json.genie.ts'
import effectSchemaFormAriaTsconfig from '../packages/@overeng/effect-schema-form-aria/tsconfig.json.genie.ts'
import effectSchemaFormTsconfig from '../packages/@overeng/effect-schema-form/tsconfig.json.genie.ts'
import genieTsconfig from '../packages/@overeng/genie/tsconfig.json.genie.ts'
import kdlEffectTsconfig from '../packages/@overeng/kdl-effect/tsconfig.json.genie.ts'
import kdlTsconfig from '../packages/@overeng/kdl/tsconfig.json.genie.ts'
import megarepoTsconfig from '../packages/@overeng/megarepo/tsconfig.json.genie.ts'
import notionCliTsconfig from '../packages/@overeng/notion-cli/tsconfig.json.genie.ts'
import notionCoreTsconfig from '../packages/@overeng/notion-core/tsconfig.json.genie.ts'
import notionDatasourceSyncTsconfig from '../packages/@overeng/notion-datasource-sync/tsconfig.json.genie.ts'
import notionEffectClientTsconfig from '../packages/@overeng/notion-effect-client/tsconfig.json.genie.ts'
import notionEffectSchemaTsconfig from '../packages/@overeng/notion-effect-schema/tsconfig.json.genie.ts'
import notionMdTsconfig from '../packages/@overeng/notion-md/tsconfig.json.genie.ts'
import notionPropertyWriteTsconfig from '../packages/@overeng/notion-property-write/tsconfig.json.genie.ts'
import notionReactTsconfig from '../packages/@overeng/notion-react/tsconfig.json.genie.ts'
import otelContractTsconfig from '../packages/@overeng/otel-contract/tsconfig.json.genie.ts'
import oxcConfigTsconfig from '../packages/@overeng/oxc-config/tsconfig.json.genie.ts'
import ptyEffectTsconfig from '../packages/@overeng/pty-effect/tsconfig.json.genie.ts'
import reactInspectorTsconfig from '../packages/@overeng/react-inspector/tsconfig.json.genie.ts'
import reactInspectorStrictConsumerTsconfig from '../packages/@overeng/react-inspector/tsconfig.strict-consumer.json.genie.ts'
import restateEffectTsconfig from '../packages/@overeng/restate-effect/tsconfig.json.genie.ts'
import tuiCoreTsconfig from '../packages/@overeng/tui-core/tsconfig.json.genie.ts'
import tuiReactTsconfig from '../packages/@overeng/tui-react/tsconfig.json.genie.ts'
import tuiStoriesTsconfig from '../packages/@overeng/tui-stories/tsconfig.json.genie.ts'
import utilsDevTsconfig from '../packages/@overeng/utils-dev/tsconfig.json.genie.ts'
import utilsTsconfig from '../packages/@overeng/utils/tsconfig.json.genie.ts'
import type { GenieOutput, TSConfigArgs } from '../packages/@overeng/genie/src/runtime/mod.ts'

export type RootTsconfigProject = {
  path: string
  tsconfig: GenieOutput<TSConfigArgs>
}

const workspaceTsconfigsByPath = new Map<string, GenieOutput<TSConfigArgs>>([
  ['context/effect/socket', effectSocketTsconfig],
  ['context/opentui', opentuiTsconfig],
  ['packages/@overeng/agent-session-ingest', agentSessionIngestTsconfig],
  ['packages/@overeng/ci-tools', ciToolsTsconfig],
  ['packages/@overeng/content-address', contentAddressTsconfig],
  ['packages/@overeng/effect-ai-claude-cli', effectAiClaudeCliTsconfig],
  ['packages/@overeng/effect-distributed-lock', effectDistributedLockTsconfig],
  ['packages/@overeng/effect-path', effectPathTsconfig],
  ['packages/@overeng/effect-react', effectReactTsconfig],
  ['packages/@overeng/effect-rpc-tanstack', effectRpcTanstackTsconfig],
  ['packages/@overeng/effect-rpc-tanstack/examples/basic', effectRpcTanstackBasicTsconfig],
  ['packages/@overeng/effect-schema-form', effectSchemaFormTsconfig],
  ['packages/@overeng/effect-schema-form-aria', effectSchemaFormAriaTsconfig],
  ['packages/@overeng/genie', genieTsconfig],
  ['packages/@overeng/kdl', kdlTsconfig],
  ['packages/@overeng/kdl-effect', kdlEffectTsconfig],
  ['packages/@overeng/megarepo', megarepoTsconfig],
  ['packages/@overeng/notion-cli', notionCliTsconfig],
  ['packages/@overeng/notion-core', notionCoreTsconfig],
  ['packages/@overeng/notion-datasource-sync', notionDatasourceSyncTsconfig],
  ['packages/@overeng/notion-effect-client', notionEffectClientTsconfig],
  ['packages/@overeng/notion-effect-schema', notionEffectSchemaTsconfig],
  ['packages/@overeng/notion-md', notionMdTsconfig],
  ['packages/@overeng/notion-property-write', notionPropertyWriteTsconfig],
  ['packages/@overeng/notion-react', notionReactTsconfig],
  ['packages/@overeng/otel-contract', otelContractTsconfig],
  ['packages/@overeng/oxc-config', oxcConfigTsconfig],
  ['packages/@overeng/pty-effect', ptyEffectTsconfig],
  ['packages/@overeng/react-inspector', reactInspectorTsconfig],
  ['packages/@overeng/restate-effect', restateEffectTsconfig],
  ['packages/@overeng/tui-core', tuiCoreTsconfig],
  ['packages/@overeng/tui-react', tuiReactTsconfig],
  ['packages/@overeng/tui-stories', tuiStoriesTsconfig],
  ['packages/@overeng/utils', utilsTsconfig],
  ['packages/@overeng/utils-dev', utilsDevTsconfig],
])

const rootWorkspacePackagePaths = rootWorkspacePackages.map(
  (pkg) => pkg.meta.workspace.memberPath,
)

const missingTsconfigPaths = rootWorkspacePackagePaths.filter(
  (path) => workspaceTsconfigsByPath.has(path) === false,
)
const extraTsconfigPaths = [...workspaceTsconfigsByPath.keys()].filter(
  (path) => rootWorkspacePackagePaths.includes(path) === false,
)

if (missingTsconfigPaths.length > 0 || extraTsconfigPaths.length > 0) {
  throw new Error(
    [
      'root tsconfig project registry drifted from rootWorkspacePackages',
      missingTsconfigPaths.length > 0
        ? `missing tsconfig data for workspace packages: ${missingTsconfigPaths.join(', ')}`
        : undefined,
      extraTsconfigPaths.length > 0
        ? `tsconfig data without workspace package: ${extraTsconfigPaths.join(', ')}`
        : undefined,
    ]
      .filter((line) => line !== undefined)
      .join('\n'),
  )
}

const workspaceTsconfigProject = (path: string): RootTsconfigProject => {
  const tsconfig = workspaceTsconfigsByPath.get(path)
  if (tsconfig === undefined) {
    throw new Error(`missing tsconfig data for workspace package: ${path}`)
  }
  return { path, tsconfig }
}

export const rootWorkspaceTsconfigProjects = rootWorkspacePackagePaths.map(workspaceTsconfigProject)

export const extraRootTsconfigProjects = [
  {
    path: 'packages/@overeng/react-inspector/tsconfig.strict-consumer.json',
    tsconfig: reactInspectorStrictConsumerTsconfig,
  },
] satisfies readonly RootTsconfigProject[]

export const rootTsconfigProjects = [
  ...rootWorkspaceTsconfigProjects,
  ...extraRootTsconfigProjects,
] as const
