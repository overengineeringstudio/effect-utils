import { createContext, useContext } from 'react'

/**
 * Host-provided URL resolver for Notion page/block references. The web mirror
 * has no knowledge of where the host app renders a given page, so consumers
 * that want clickable `<ChildPage>` / `<LinkToPage>` / page-`<Mention>` chips
 * mount a provider that maps a `{ pageId, blockId? }` ref to an app URL.
 *
 * Policy (phase 5b-1 / D1):
 * - Synchronous. Async/lazy resolution is out of scope for v0.1.
 * - Optional. Callers without a provider get `undefined`; consumers fall back
 *   to the pre-phase-5a non-clickable rendering.
 * - Silent miss. `resolve` may return `undefined`; consumers also treat that
 *   as "no URL".
 *
 * Mirrors the silent-fallback shape of {@link UploadRegistry}.
 */
export type NotionUrlResolver = (ref: {
  readonly pageId: string
  readonly blockId?: string
}) => string | undefined

export type NotionUrlProvider = {
  readonly resolve: NotionUrlResolver
}

const NotionUrlContext = createContext<NotionUrlProvider | undefined>(undefined)

export const NotionUrlProviderProvider = NotionUrlContext.Provider

/**
 * Resolve a page/block ref to an app URL via the mounted {@link NotionUrlProvider}.
 * Returns `undefined` when no provider is mounted OR when the provider's
 * `resolve` returns `undefined`.
 */
export const useNotionUrl = (ref: {
  readonly pageId: string
  readonly blockId?: string
}): string | undefined => {
  const provider = useContext(NotionUrlContext)
  return provider?.resolve(ref)
}
