import { Context, type Effect } from 'effect'

import type { NmdStorage } from '@overeng/notion-effect-client'

export type RemoteParent =
  | { readonly type: 'page_id'; readonly page_id: string }
  | { readonly type: 'data_source_id'; readonly data_source_id: string }
  | { readonly type: 'database_id'; readonly database_id: string }
  | { readonly type: 'block_id'; readonly block_id: string }
  | { readonly type: 'workspace'; readonly workspace: true }
  | { readonly type: 'unknown'; readonly raw: unknown }

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

export interface RemoteMarkdownSnapshot {
  readonly markdown: string
  readonly truncated: boolean
  readonly unknown_block_ids: readonly string[]
}

export interface PullPageResult {
  readonly page: RemotePageSnapshot
  readonly markdown: RemoteMarkdownSnapshot
  readonly storage?: NmdStorage
}

export interface UpdateMarkdownResult {
  readonly markdown: RemoteMarkdownSnapshot
}

export interface NotionMdGatewayShape {
  readonly pullPage: (opts: { readonly pageId: string }) => Effect.Effect<PullPageResult, unknown>
  readonly updateMarkdown: (opts: {
    readonly pageId: string
    readonly markdown: string
    readonly allowDeletingContent: boolean
  }) => Effect.Effect<UpdateMarkdownResult, unknown>
  readonly updatePageProperties: (opts: {
    readonly pageId: string
    readonly properties: Record<string, unknown>
  }) => Effect.Effect<RemotePageSnapshot, unknown>
}

export class NotionMdGateway extends Context.Tag('NotionMdGateway')<
  NotionMdGateway,
  NotionMdGatewayShape
>() {}
