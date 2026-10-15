import { NodeRuntime, NodeServices } from '@effect/platform-node'
import { Effect } from 'effect'
import * as FetchHttpClient from 'effect/http/FetchHttpClient'

import { checkDeployedPnpm, deployedPnpmRegistryUrl } from '../src/pnpm-deployed.ts'

checkDeployedPnpm({
  root: process.cwd(),
  registryUrl: process.env.PNPM_DEPLOYED_REGISTRY_URL ?? deployedPnpmRegistryUrl,
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provide(FetchHttpClient.layer),
  NodeRuntime.runMain({}),
)
