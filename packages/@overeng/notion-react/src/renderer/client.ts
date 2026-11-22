import { Context, Effect, Layer, Stream } from 'effect'
import type { HttpClient } from 'effect/http/HttpClient'
import {
  NotionBlocks as DefaultBlocks, NotionPages as DefaultPages,
  type NotionConfig, type NotionApiError, type PaginatedResult,
  type AppendBlockChildrenOptions, type UpdateBlockOptions, type DeleteBlockOptions,
  type RetrieveBlockChildrenOptions, type CreatePageOptions, type UpdatePageOptions,
  type ArchivePageOptions, type MovePageOptions, type RetrievePageOptionsBase,
} from '@overeng/notion-effect-client'
import type { Block, Page } from '@overeng/notion-effect-schema'

/** Client capability, not credentials. Consumers retain authorization, throttle and journal ownership. */
export interface NotionRendererClientShape {
  readonly blocks: {
    readonly append: (opts: AppendBlockChildrenOptions) => Effect.Effect<{ readonly object: 'list'; readonly results: readonly Block[] }, NotionApiError>
    readonly update: (opts: UpdateBlockOptions) => Effect.Effect<Block, NotionApiError>
    readonly delete: (opts: DeleteBlockOptions) => Effect.Effect<Block, NotionApiError>
    readonly retrieveChildren: (opts: RetrieveBlockChildrenOptions) => Effect.Effect<PaginatedResult<Block>, NotionApiError>
    readonly retrieveChildrenStream: (opts: Omit<RetrieveBlockChildrenOptions, 'startCursor'>) => Stream.Stream<Block, NotionApiError>
  }
  readonly pages: {
    readonly create: (opts: CreatePageOptions) => Effect.Effect<Page, NotionApiError>
    readonly update: (opts: UpdatePageOptions) => Effect.Effect<Page, NotionApiError>
    readonly archive: (opts: ArchivePageOptions) => Effect.Effect<Page, NotionApiError>
    readonly move: (opts: MovePageOptions) => Effect.Effect<Page, NotionApiError>
    readonly retrieve: (opts: RetrievePageOptionsBase) => Effect.Effect<Page, NotionApiError>
  }
}
export class NotionRendererClient extends Context.Service<NotionRendererClient, NotionRendererClientShape>()('@overeng/notion-react/NotionRendererClient') {}

/** Default token + HttpClient route. Scoped to the caller, never creates another runtime. */
export const NotionRendererClientLive = Layer.effect(NotionRendererClient, Effect.gen(function* () {
  const context = yield* Effect.context<NotionConfig | HttpClient>()
  return NotionRendererClient.of({
    blocks: {
      append: opts => Effect.provide(DefaultBlocks.append(opts), context),
      update: opts => Effect.provide(DefaultBlocks.update(opts), context),
      delete: opts => Effect.provide(DefaultBlocks.delete(opts), context),
      retrieveChildren: opts => Effect.provide(DefaultBlocks.retrieveChildren(opts), context),
      retrieveChildrenStream: opts => Stream.provideContext(DefaultBlocks.retrieveChildrenStream(opts), context),
    },
    pages: {
      create: opts => Effect.provide(DefaultPages.create(opts), context),
      update: opts => Effect.provide(DefaultPages.update(opts), context),
      archive: opts => Effect.provide(DefaultPages.archive(opts), context),
      move: opts => Effect.provide(DefaultPages.move(opts), context),
      retrieve: opts => Effect.provide(DefaultPages.retrieve(opts), context),
    },
  })
}))

export const NotionBlocks = {
  append: (opts: Parameters<typeof DefaultBlocks.append>[0]) => NotionRendererClient.use(client => client.blocks.append(opts)),
  update: (opts: Parameters<typeof DefaultBlocks.update>[0]) => NotionRendererClient.use(client => client.blocks.update(opts)),
  delete: (opts: Parameters<typeof DefaultBlocks.delete>[0]) => NotionRendererClient.use(client => client.blocks.delete(opts)),
  retrieveChildren: (opts: Parameters<typeof DefaultBlocks.retrieveChildren>[0]) => NotionRendererClient.use(client => client.blocks.retrieveChildren(opts)),
  retrieveChildrenStream: (opts: Parameters<typeof DefaultBlocks.retrieveChildrenStream>[0]) => Stream.unwrap(NotionRendererClient.use(client => Effect.succeed(client.blocks.retrieveChildrenStream(opts)))),
}
export const NotionPages = {
  create: (opts: Parameters<typeof DefaultPages.create>[0]) => NotionRendererClient.use(client => client.pages.create(opts)),
  update: (opts: Parameters<typeof DefaultPages.update>[0]) => NotionRendererClient.use(client => client.pages.update(opts)),
  archive: (opts: Parameters<typeof DefaultPages.archive>[0]) => NotionRendererClient.use(client => client.pages.archive(opts)),
  move: (opts: Parameters<typeof DefaultPages.move>[0]) => NotionRendererClient.use(client => client.pages.move(opts)),
  retrieve: (opts: { readonly pageId: string }) => NotionRendererClient.use(client => client.pages.retrieve(opts)),
}
