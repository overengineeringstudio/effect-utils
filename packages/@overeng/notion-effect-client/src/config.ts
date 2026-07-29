import { Config, Context, Effect, Option, Redacted, Schema } from 'effect'

import { sha256Hex } from '@overeng/utils'

export { NOTION_API_BASE_URL, NOTION_API_VERSION } from '@overeng/notion-core'

/** Configuration for the Notion client */
export interface NotionClientConfig {
  /** Notion integration token (Bearer token) */
  readonly authToken: Redacted.Redacted<string>
  /** Enable automatic retry with exponential backoff (default: true) */
  readonly retryEnabled?: boolean
  /** Maximum number of retry attempts (default: 3) */
  readonly maxRetries?: number
  /** Base delay for exponential backoff in ms (default: 1000) */
  readonly retryBaseDelay?: number
}

/** Context tag for NotionClientConfig */
export class NotionConfig extends Context.Service<NotionConfig, NotionClientConfig>()(
  'NotionConfig',
) {}

/**
 * Environment variable names checked for the Notion API token, in precedence order.
 *
 * The canonical superset honored across all CLIs: the first non-empty value wins.
 */
export const NOTION_TOKEN_ENV_VARS = ['NOTION_API_TOKEN', 'NOTION_TOKEN'] as const

/** Raised when no Notion API token is available from any checked source. */
export class NotionTokenMissing extends Schema.TaggedErrorClass<NotionTokenMissing>()(
  'NotionTokenMissing',
  {
    message: Schema.String,
    /** Environment variable names that were checked, in precedence order. */
    envVars: Schema.Array(Schema.String),
  },
) {}

/**
 * Resolve the Notion API token from the environment, in precedence order
 * (`NOTION_API_TOKEN`, then `NOTION_TOKEN`). The first non-empty value wins.
 *
 * Returns a `Redacted<string>` since the token is sensitive. Fails with
 * `NotionTokenMissing` when none of the checked variables hold a non-empty value.
 */
export const resolveNotionToken = Effect.fn('resolveNotionToken')(function* () {
  for (const name of NOTION_TOKEN_ENV_VARS) {
    const candidate = yield* Config.option(Config.redacted(name))
    if (Option.isSome(candidate) === true && Redacted.value(candidate.value).length > 0) {
      return candidate.value
    }
  }

  return yield* new NotionTokenMissing({
    message: `Missing Notion API token; set one of: ${NOTION_TOKEN_ENV_VARS.join(', ')}`,
    envVars: NOTION_TOKEN_ENV_VARS,
  })
})

/**
 * Produce a log-safe fingerprint of a Notion integration token so a user can
 * tell *which* credential is active without leaking the secret.
 *
 * Format: `` `<scheme>…#<8hex>` `` where `<scheme>` is the public token-type
 * prefix (everything up to and including the first `_`, e.g. `ntn_` / `secret_`)
 * and `<8hex>` is the first 8 hex chars of `sha256(token)`. An empty token
 * yields `<none>`. A token with no `_` yields `…#<8hex>` with an empty scheme.
 *
 * Security: never emits any secret bytes beyond the scheme prefix. The first-`_`
 * split is done via `indexOf` (not `split('_')[0]`, which would return the whole
 * token when no `_` is present).
 */
export const notionTokenFingerprint = (token: Redacted.Redacted<string>): string => {
  const raw = Redacted.value(token)
  if (raw.length === 0) return '<none>'
  const sep = raw.indexOf('_')
  const scheme = sep === -1 ? '' : raw.slice(0, sep + 1)
  const digest = sha256Hex(raw).slice(0, 8)
  return `${scheme}…#${digest}`
}
