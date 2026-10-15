import { Schema } from 'effect'

import { attr, defineOtelContract, metric, required } from '@overeng/otel-contract/registry'

/** Configured authentication identities, never individual requests or tokens. */
export const AppLabels = Schema.Struct({
  clientID: attr.string({
    key: 'github.app.client_id',
    cardinality: 'bounded',
    stability: 'development',
    brief: 'Configured GitHub App client ID.',
    examples: ['Iv1.example'],
  }),
  installationID: attr.string({
    key: 'github.installation.id',
    cardinality: 'bounded',
    stability: 'development',
    brief: 'Configured GitHub App installation ID.',
    examples: ['123'],
  }),
  consumer: attr.string({
    key: 'github.consumer',
    cardinality: 'bounded',
    stability: 'development',
    brief: 'Stable configured consumer identity.',
    examples: ['ci-reader'],
  }),
})
/** Finite GitHub rate-limit resource vocabulary for bounded metric labels. */
export const Resource = attr.enum({
  key: 'github.resource',
  values: ['core', 'search', 'graphql', 'integration_manifest', 'code_search'],
  briefs: {
    core: 'REST core budget.',
    search: 'Search budget.',
    graphql: 'GraphQL budget.',
    integration_manifest: 'App manifest budget.',
    code_search: 'Code search budget.',
  },
  brief: 'GitHub rate-limit resource bucket.',
  stability: 'development',
})
const labels = {
  clientID: required(AppLabels.fields.clientID),
  installationID: required(AppLabels.fields.installationID),
  consumer: required(AppLabels.fields.consumer),
}
const rateLabels = { ...labels, resource: required(Resource) }

/** Attempts, including signing, transport, HTTP and decoding failures; not successes. */
export const MintCount = metric({
  id: 'metric.github.app.mints',
  name: 'github_app_mints_total',
  instrument: 'counter',
  unit: '1',
  brief: 'Installation token mint attempts',
  stability: 'development',
  labels,
})
/** Failed installation-token mint attempts. */
export const MintFailures = metric({
  id: 'metric.github.app.mint_failures',
  name: 'github_app_mint_failures_total',
  instrument: 'counter',
  unit: '1',
  brief: 'Failed installation token mint attempts',
  stability: 'development',
  labels,
})
/** Earliest cached installation-token expiry, expressed as Unix seconds. */
export const TokenExpiry = metric({
  id: 'metric.github.app.token_expiry',
  name: 'github_app_token_expiry_seconds',
  instrument: 'gauge',
  unit: 's',
  brief: 'Earliest cached token expiry (Unix seconds); zero when invalidated',
  stability: 'development',
  labels,
})
/** Last observed remaining budget for each GitHub resource. */
export const RateRemaining = metric({
  id: 'metric.github.app.rate_limit.remaining',
  name: 'github_app_rate_limit_remaining',
  instrument: 'gauge',
  unit: '1',
  brief: 'Last observed GitHub budget, separated by resource bucket',
  stability: 'development',
  labels: rateLabels,
})
/** Last observed budget limit for each GitHub resource. */
export const RateLimit = metric({
  id: 'metric.github.app.rate_limit.limit',
  name: 'github_app_rate_limit_limit',
  instrument: 'gauge',
  unit: '1',
  brief: 'Last observed GitHub budget limit, separated by resource bucket',
  stability: 'development',
  labels: rateLabels,
})
/** Last observed budget reset time for each GitHub resource, as Unix seconds. */
export const RateReset = metric({
  id: 'metric.github.app.rate_limit.reset_at',
  name: 'github_app_rate_limit_reset_at_seconds',
  instrument: 'gauge',
  unit: 's',
  brief: 'Last observed GitHub budget reset time (Unix seconds), separated by resource bucket',
  stability: 'development',
  labels: rateLabels,
})

export default defineOtelContract({
  memberPath: 'packages/@overeng/utils',
  displayName: 'GitHub App Authentication',
  signals: [MintCount, MintFailures, TokenExpiry, RateRemaining, RateLimit, RateReset],
})
