import { Flag as Options } from 'effect/unstable/cli'
import { Effect, Option, Redacted } from 'effect'

import { resolveNotionToken as resolveNotionTokenFromEnv } from '@overeng/notion-effect-client'

/** Resolve the Notion API token as a `Redacted` value from the CLI option or the environment. */
export const resolveNotionToken = (token: Option.Option<string>) =>
  Option.isSome(token) === true
    ? Effect.succeed(Redacted.make(token.value))
    : resolveNotionTokenFromEnv()

/** CLI option for providing a Notion API token (defaults to `NOTION_API_TOKEN`). */
export const tokenOption = Options.string('token').pipe(
  Options.withAlias('t'),
  Options.withDescription('Notion API token (defaults to NOTION_API_TOKEN env var)'),
  Options.optional,
)
