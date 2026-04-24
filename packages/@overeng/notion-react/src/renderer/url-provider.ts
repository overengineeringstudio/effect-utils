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
 * Return shape: resolvers may return either a bare URL string or an object
 * with anchor attributes (`href`, optional `target`, optional `rel`). The
 * object form is load-bearing for embedded renderers (e.g. Storybook) where
 * the anchor must break out of an iframe via `target="_top"` to avoid
 * navigating the preview frame itself.
 *
 * Mirrors the silent-fallback shape of {@link UploadRegistry}.
 */
export type NotionUrlHref =
  | string
  | {
      readonly href: string
      readonly target?: '_self' | '_blank' | '_parent' | '_top'
      readonly rel?: string
    }

export type NotionUrlResolver = (ref: {
  readonly pageId: string
  readonly blockId?: string
}) => NotionUrlHref | undefined

export type NotionUrlProvider = {
  readonly resolve: NotionUrlResolver
}

/** Normalized shape returned by {@link useNotionUrl}. Consumers spread onto `<a>`. */
export type ResolvedNotionUrl = {
  readonly href: string
  readonly target?: string
  readonly rel?: string
}

const NotionUrlContext = createContext<NotionUrlProvider | undefined>(undefined)

export const NotionUrlProviderProvider = NotionUrlContext.Provider

/**
 * Resolve a page/block ref to an app URL via the mounted {@link NotionUrlProvider}.
 * Returns `undefined` when no provider is mounted OR when the provider's
 * `resolve` returns `undefined`. String returns from the resolver are
 * normalized to `{ href }` so consumers can uniformly spread the result.
 */
export const useNotionUrl = (ref: {
  readonly pageId: string
  readonly blockId?: string
}): ResolvedNotionUrl | undefined => {
  const provider = useContext(NotionUrlContext)
  const raw = provider?.resolve(ref)
  if (raw === undefined) return undefined
  if (typeof raw === 'string') return { href: raw }
  return raw
}
