import { Context } from 'effect'

/** Notion API version - hardcoded to match our schemas */
export const NOTION_API_VERSION = '2022-06-28'

/** Base URL for Notion API */
export const NOTION_API_BASE_URL = 'https://api.notion.com/v1'

/** Configuration for the Notion client */
export interface NotionClientConfig {
  /** Notion integration token (Bearer token) */
  readonly authToken: string
  /** Enable automatic retry with exponential backoff (default: true) */
  readonly retryEnabled?: boolean
  /** Maximum number of retry attempts (default: 3) */
  readonly maxRetries?: number
  /** Base delay for exponential backoff in ms (default: 1000) */
  readonly retryBaseDelay?: number
}

/** Context tag for NotionClientConfig */
export class NotionConfig extends Context.Tag('NotionConfig')<NotionConfig, NotionClientConfig>() {}
