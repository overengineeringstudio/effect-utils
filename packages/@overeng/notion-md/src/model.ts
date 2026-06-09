import { Context, type Effect } from 'effect'

import type { BodyCompleteness } from '@overeng/notion-core'
import type { NmdPageState, NmdStorage } from '@overeng/notion-effect-client'

import type { NmdGatewayError } from './errors.ts'

/** Child page discovered under a Notion page. */
export interface RemoteChildPage {
  readonly pageId: string
  readonly title: string
}

/** Remote Notion parent shapes normalized for `.nmd` frontmatter. */
export type RemoteParent =
  | { readonly type: 'page_id'; readonly page_id: string }
  | { readonly type: 'data_source_id'; readonly data_source_id: string }
  | { readonly type: 'database_id'; readonly database_id: string }
  | { readonly type: 'block_id'; readonly block_id: string }
  | { readonly type: 'workspace'; readonly workspace: true }
  | { readonly type: 'agent_id'; readonly agent_id: string }
  | { readonly type: 'unknown'; readonly raw: unknown }

/** Stable page metadata needed to rebuild `.nmd` frontmatter after a pull. */
export interface RemotePageSnapshot {
  readonly id: string
  readonly title: string
  /*
   * Property key under which Notion stores the title rich-text. On standalone
   * pages this is `"title"`; on database/data-source pages it matches the
   * database column name (commonly `"Name"`). Carried alongside so writes
   * can target the correct key without re-scanning the property bag.
   */
  readonly title_property_key: string
  readonly url: string | undefined
  readonly parent: RemoteParent
  readonly icon: NmdPageState['icon']
  readonly cover: NmdPageState['cover']
  readonly in_trash: boolean
  readonly is_locked: boolean
  readonly last_edited_time: string
  readonly properties: Record<string, unknown>
}

/** Markdown export result returned by Notion's enhanced Markdown endpoint. */
export interface RemoteMarkdownSnapshot {
  /**
   * Markdown body that notion-md may adopt as the local/base body when the
   * associated completeness evidence is complete. Live pulls derive this from
   * the block-tree renderer; endpoint Markdown remains diagnostic evidence.
   */
  readonly markdown: string
  readonly endpoint_markdown?: string
  readonly truncated: boolean
  readonly unknown_block_ids: readonly string[]
  readonly completeness?: BodyCompleteness
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

/** Page icon values the Notion page update API accepts through frontmatter. */
export type WritablePageIcon = null | Extract<
  NonNullable<NmdPageState['icon']>,
  { readonly type: 'emoji' | 'external' | 'icon' }
>

/** Page cover values the Notion page update API accepts through frontmatter. */
export type WritablePageCover = null | Extract<
  NonNullable<NmdPageState['cover']>,
  { readonly type: 'external' }
>

/** Field-level page metadata patch derived from strict frontmatter. */
export interface PageMetadataUpdate {
  /*
   * Title update carries the property *key* under which Notion stores the
   * title rich-text — required because database/data-source pages name
   * that property after the database column, not always `"title"`. The
   * sync engine sources `title_property_key` from `RemotePageSnapshot`.
   */
  readonly title?: { readonly key: string; readonly value: string }
  readonly icon?: WritablePageIcon
  readonly cover?: WritablePageCover
  readonly in_trash?: boolean
  readonly is_locked?: boolean
}

/** Exact search-and-replace operation for Notion's `update_content` command. */
export interface MarkdownContentUpdate {
  readonly oldStr: string
  readonly newStr: string
  readonly replaceAllMatches?: boolean
}

/** Markdown update transport selected by the sync engine. */
export type MarkdownUpdateCommand =
  | {
      readonly _tag: 'update_content'
      readonly contentUpdates: readonly MarkdownContentUpdate[]
      readonly expectedMarkdown: string
    }
  | {
      readonly _tag: 'replace_content'
      readonly markdown: string
    }

/** Minimal gateway boundary between sync logic and the Notion API. */
export interface NotionMdGatewayShape {
  readonly pullPage: (opts: {
    readonly pageId: string
  }) => Effect.Effect<PullPageResult, NmdGatewayError>
  readonly updateMarkdown: (opts: {
    readonly pageId: string
    readonly command: MarkdownUpdateCommand
    readonly allowDeletingContent: boolean
  }) => Effect.Effect<UpdateMarkdownResult, NmdGatewayError>
  readonly updatePageProperties: (opts: {
    readonly pageId: string
    readonly properties: Record<string, unknown>
  }) => Effect.Effect<RemotePageSnapshot, NmdGatewayError>
  readonly updatePageMetadata: (opts: {
    readonly pageId: string
    readonly metadata: PageMetadataUpdate
  }) => Effect.Effect<RemotePageSnapshot, NmdGatewayError>
  /** List direct child pages under a Notion page. */
  readonly listChildPages: (opts: {
    readonly pageId: string
  }) => Effect.Effect<readonly RemoteChildPage[], NmdGatewayError>
  /**
   * Create a new page under a parent page with title + canonicalized body.
   *
   * Notion auto-appends a `<page url>` child-reference block to the parent
   * body when a page is created with a `page_id` parent — so the tree engine
   * never hand-authors a child anchor for a freshly created page; it re-emits
   * the full derived anchor set on the parent's own push instead.
   */
  readonly createPage: (opts: {
    readonly parentPageId: string
    readonly title: string
    readonly markdown: string
  }) => Effect.Effect<RemotePageSnapshot, NmdGatewayError>
  /** Move a page to a new parent page (preserves page id / identity). */
  readonly movePage: (opts: {
    readonly pageId: string
    readonly parentPageId: string
  }) => Effect.Effect<RemotePageSnapshot, NmdGatewayError>
  /** Trash (soft-delete) a page. */
  readonly archivePage: (opts: {
    readonly pageId: string
  }) => Effect.Effect<RemotePageSnapshot, NmdGatewayError>
}

/** Effect service tag for Notion Markdown sync operations. */
export class NotionMdGateway extends Context.Tag('NotionMdGateway')<
  NotionMdGateway,
  NotionMdGatewayShape
>() {}
