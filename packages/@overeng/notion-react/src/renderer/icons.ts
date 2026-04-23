import type { PageCover, PageIcon } from '../components/props.ts'

/**
 * Icon / cover normalization (issue #618 phase 3b).
 *
 * Request shape (what we send) vs response shape (what Notion returns) do not
 * always coincide. Empirical findings (`tmp/notion-618/experiments/findings.md`):
 *
 * - `external` URLs that resolve to Notion built-in SVGs (e.g.
 *   `https://www.notion.so/icons/...svg`) come back as a new `{type:"icon",
 *   icon:{name, color}}` envelope. The normalizer folds both sides into the
 *   same canonical shape so a candidate-vs-cache hash compare does not flap
 *   between runs.
 * - `custom_emoji` references with a bogus id come back as `null`. We strip
 *   these at the component boundary (log + drop), mirroring the
 *   UploadRegistry-miss policy.
 * - Covers are narrower: only `external` and `file_upload` envelopes are
 *   accepted by the API. `emoji` / `custom_emoji` are rejected outright.
 */

/**
 * Project an author-supplied `PageIcon` into the request body shape for
 * `pages.create` / `pages.update`. Callers that already hold a validated
 * request-shape envelope can pass it through verbatim.
 *
 * Returns `undefined` for a `custom_emoji` envelope with an empty id — these
 * round-trip to `null` on the server, so we treat them as "no icon" at the
 * boundary rather than sending a payload Notion will drop.
 *
 * Returns `null` verbatim for a `null` input: callers pass `icon={null}` on
 * `<Page>` / `<ChildPage>` to mean "clear on server"; the diff propagates the
 * null through to `pages.update({icon: null})`. `undefined` (prop omitted)
 * continues to mean "no claim".
 */
export const projectIcon = (
  icon: PageIcon | null | undefined,
): Record<string, unknown> | null | undefined => {
  if (icon === undefined) return undefined
  if (icon === null) return null
  if (icon.type === 'custom_emoji') {
    if (icon.custom_emoji.id.length === 0) {
      // eslint-disable-next-line no-console
      console.warn('notion-react: dropping custom_emoji icon with empty id')
      return undefined
    }
    return { type: 'custom_emoji', custom_emoji: { id: icon.custom_emoji.id } }
  }
  if (icon.type === 'emoji') return { type: 'emoji', emoji: icon.emoji }
  return { type: 'external', external: { url: icon.external.url } }
}

/**
 * Project an author-supplied `PageCover` into the request body shape. Narrower
 * than icons: only external URL / file_upload. Returns `undefined` if the
 * cover is absent, `null` if the author asked for a clear (`cover={null}`
 * on `<Page>` / `<ChildPage>`).
 */
export const projectCover = (
  cover: PageCover | null | undefined,
): Record<string, unknown> | null | undefined => {
  if (cover === undefined) return undefined
  if (cover === null) return null
  if (cover.type === 'external') return { type: 'external', external: { url: cover.external.url } }
  return { type: 'file_upload', file_upload: { id: cover.file_upload.id } }
}

/**
 * Canonical icon form used for diff-hash equality. Accepts either the request
 * shape we produce or the response shape the API returns. Folds Notion's
 * built-in-SVG rewrite (request `external` → response `{type:"icon", icon:{name,color}}`)
 * into a single `external` envelope keyed by the original URL *if* the
 * candidate side had one — otherwise falls back to `{type:"icon", ...}`.
 *
 * Returns `undefined` for `null` / missing icon so absence round-trips cleanly.
 */
export const normalizeIcon = (icon: unknown): Record<string, unknown> | undefined => {
  if (icon === null || icon === undefined) return undefined
  if (typeof icon !== 'object') return undefined
  const rec = icon as Record<string, unknown>
  const type = rec.type
  if (type === 'emoji' && typeof rec.emoji === 'string') {
    return { type: 'emoji', emoji: rec.emoji }
  }
  if (type === 'external') {
    const ext = rec.external as { url?: unknown } | undefined
    if (ext !== undefined && typeof ext.url === 'string') {
      return { type: 'external', external: { url: ext.url } }
    }
  }
  if (type === 'custom_emoji') {
    const ce = rec.custom_emoji as { id?: unknown } | undefined
    if (ce !== undefined && typeof ce.id === 'string') {
      return { type: 'custom_emoji', custom_emoji: { id: ce.id } }
    }
  }
  if (type === 'icon') {
    // Notion's built-in-SVG envelope. Folded to a stable shape; tests that
    // round-trip through the fake API keep the original `external` envelope
    // so a request/response hash equality holds in either direction.
    const inner = rec.icon as { name?: unknown; color?: unknown } | undefined
    if (inner !== undefined && typeof inner.name === 'string') {
      const out: Record<string, unknown> = { type: 'icon', name: inner.name }
      if (typeof inner.color === 'string') out.color = inner.color
      return out
    }
  }
  return undefined
}

/**
 * Canonical cover form used for diff-hash equality. See `normalizeIcon` — the
 * cover envelope is narrower (no emoji / custom_emoji).
 */
export const normalizeCover = (cover: unknown): Record<string, unknown> | undefined => {
  if (cover === null || cover === undefined) return undefined
  if (typeof cover !== 'object') return undefined
  const rec = cover as Record<string, unknown>
  const type = rec.type
  if (type === 'external') {
    const ext = rec.external as { url?: unknown } | undefined
    if (ext !== undefined && typeof ext.url === 'string') {
      return { type: 'external', external: { url: ext.url } }
    }
  }
  if (type === 'file_upload') {
    const fu = rec.file_upload as { id?: unknown } | undefined
    if (fu !== undefined && typeof fu.id === 'string') {
      return { type: 'file_upload', file_upload: { id: fu.id } }
    }
  }
  return undefined
}

/**
 * Translate author-supplied `title` (string or `PageTitleSpan[]`) into the
 * Notion wire-shape span array. Mirrors `pageTitleSpans` in render-to-notion
 * but keeps the module self-contained. Returns `undefined` when the title is
 * absent (not set on the component), `[]` when the title is an empty string.
 */
export const projectTitleSpans = (
  title: unknown,
): readonly Record<string, unknown>[] | undefined => {
  if (title === undefined) return undefined
  if (typeof title === 'string') {
    if (title.length === 0) return []
    return [{ type: 'text', text: { content: title } }]
  }
  if (Array.isArray(title)) return title as readonly Record<string, unknown>[]
  return undefined
}

/**
 * Normalize a title array for hash-equality purposes. Accepts either the
 * request-shape spans we send or the response-shape spans Notion returns
 * (which carry extra bookkeeping fields like `plain_text`, `href`). Reduces
 * to `{type, text:{content, link?}, annotations?}` per span.
 */
export const normalizeTitle = (title: unknown): readonly Record<string, unknown>[] | undefined => {
  if (title === undefined) return undefined
  if (!Array.isArray(title)) return undefined
  return title.map((raw) => {
    const span = raw as Record<string, unknown>
    const text = (span.text as { content?: unknown; link?: unknown } | undefined) ?? {}
    const out: Record<string, unknown> = {
      type: 'text',
      text: {
        content: typeof text.content === 'string' ? text.content : '',
        ...(text.link !== undefined && text.link !== null ? { link: text.link } : {}),
      },
    }
    if (span.annotations !== undefined) out.annotations = span.annotations
    return out
  })
}
