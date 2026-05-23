import { Context, type Effect } from 'effect'

import type { NmdStorage } from '@overeng/notion-effect-client'

import type { NmdGatewayError } from './errors.ts'

/** Remote Notion parent shapes normalized for `.nmd` frontmatter. */
export type RemoteParent =
  | { readonly type: 'page_id'; readonly page_id: string }
  | { readonly type: 'data_source_id'; readonly data_source_id: string }
  | { readonly type: 'database_id'; readonly database_id: string }
  | { readonly type: 'block_id'; readonly block_id: string }
  | { readonly type: 'workspace'; readonly workspace: true }
  | { readonly type: 'unknown'; readonly raw: unknown }

/** Stable page metadata needed to rebuild `.nmd` frontmatter after a pull. */
export interface RemotePageSnapshot {
  readonly id: string
  readonly title: string
  readonly url: string | undefined
  readonly parent: RemoteParent
  readonly icon: unknown
  readonly cover: unknown
  readonly in_trash: boolean
  readonly is_locked: boolean
  readonly last_edited_time: string
  readonly properties: Record<string, unknown>
}

/** Markdown export result returned by Notion's enhanced Markdown endpoint. */
export interface RemoteMarkdownSnapshot {
  readonly markdown: string
  readonly truncated: boolean
  readonly unknown_block_ids: readonly string[]
}

/** Complete remote page snapshot used by the sync engine. */
export interface PullPageResult {
  readonly page: RemotePageSnapshot
  readonly markdown: RemoteMarkdownSnapshot
  readonly storage?: NmdStorage
}

/** Markdown update response from the live Notion gateway. */
export interface UpdateMarkdownResult {
  readonly markdown: RemoteMarkdownSnapshot
}

/** Minimal gateway boundary between sync logic and the Notion API. */
export interface NotionMdGatewayShape {
  readonly pullPage: (opts: {
    readonly pageId: string
  }) => Effect.Effect<PullPageResult, NmdGatewayError>
  readonly updateMarkdown: (opts: {
    readonly pageId: string
    readonly markdown: string
    readonly allowDeletingContent: boolean
  }) => Effect.Effect<UpdateMarkdownResult, NmdGatewayError>
  readonly updatePageProperties: (opts: {
    readonly pageId: string
    readonly properties: Record<string, unknown>
  }) => Effect.Effect<RemotePageSnapshot, NmdGatewayError>
}

/** Effect service tag for Notion Markdown sync operations. */
export class NotionMdGateway extends Context.Tag('NotionMdGateway')<
  NotionMdGateway,
  NotionMdGatewayShape
>() {}
