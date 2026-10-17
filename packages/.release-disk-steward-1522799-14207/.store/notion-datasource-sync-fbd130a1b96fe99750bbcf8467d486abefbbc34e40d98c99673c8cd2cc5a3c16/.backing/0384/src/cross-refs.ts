import { dirname, join } from 'node:path'

import { Effect } from 'effect'

import { compactNotionUuid } from '@overeng/notion-effect-schema'

import { NmdCliError, type NmdError } from './errors.ts'

/**
 * Cross-reference resolution for `.nmd` bodies — the inline half of the shared
 * sync-spine resolver (effect-utils #744). Neutral free functions over plain
 * `{body, relPath, slugMap, idMap}` so they are extractable to the spine (#700)
 * without depending on the tree engine's private page type.
 *
 * Two ref forms are supported, both rewritten to inline Notion page links:
 *  - `[[slug]]` / `[[slug|label]]` — wiki-style, resolved by tree slug;
 *  - `[label](./rel.nmd)` / `[label](rel.nmd)` — relative file link.
 *
 * Position-aware mention / link-to-page output (the block half of #744) is
 * future work; here every resolved ref becomes an inline markdown link, which
 * is the only form proven to round-trip through Notion's enhanced-markdown
 * endpoint (inline `<page>` corrupts).
 */

const toPosix = (value: string): string => value.split('\\').join('/')

/**
 * Canonical Notion page URL form proven to round-trip through the enhanced
 * Markdown endpoint both as an INLINE link `[label](url)` and as a block-level
 * `<page url>` anchor. Only the `app.notion.com/p/<dashless-id>` form is
 * verified to resolve to a live page link rather than dead `(#)` text.
 */
export const pageUrl = (pageId: string): string =>
  `https://app.notion.com/p/${compactNotionUuid(pageId)}`

const WIKI_REF = /\[\[([^\]]+)\]\]/gu
const FILE_REF = /\[([^\]]*)\]\((\.{0,2}\/?[^)\s]+\.nmd)\)/gu

/** Split a `slug` or `slug|label` wiki target into trimmed slug + label. */
const splitWikiTarget = (raw: string): { readonly slug: string; readonly label: string } => {
  const [slug, label] = raw.includes('|') === true ? raw.split('|', 2) : [raw, raw]
  return { slug: (slug ?? '').trim(), label: (label ?? slug ?? '').trim() }
}

/** Resolve a `[label](./rel.nmd)` href to a tree-relative posix path. */
const fileRefTarget = (opts: { readonly relPath: string; readonly href: string }): string => {
  const pageDir = dirname(opts.relPath)
  return toPosix(join(pageDir === '.' ? '' : pageDir, opts.href))
}

/**
 * Validate that every cross-ref in `body` resolves to a known local target.
 * Side-effect-free (needs no page ids), so it runs up front to fail a sync
 * CLOSED before any remote mutation. `slugMap` keys are wiki slugs; `relPaths`
 * is the full set of local relPaths for `[..](./x.nmd)` link targets.
 */
export const validateCrossRefTargets = (opts: {
  readonly body: string
  readonly relPath: string
  readonly slugMap: ReadonlyMap<string, string>
  readonly relPaths: ReadonlySet<string>
}): Effect.Effect<void, NmdError> =>
  Effect.gen(function* () {
    for (const match of opts.body.matchAll(WIKI_REF)) {
      const raw = match[1] ?? ''
      const { slug } = splitWikiTarget(raw)
      if (opts.slugMap.has(slug) === false) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [[${raw}]] in ${opts.relPath}: no page with slug "${slug}"`,
        })
      }
    }
    for (const match of opts.body.matchAll(FILE_REF)) {
      const href = match[2] ?? ''
      const target = fileRefTarget({ relPath: opts.relPath, href })
      if (opts.relPaths.has(target) === false) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [${match[1] ?? ''}](${href}) in ${opts.relPath}: no local page at "${target}"`,
        })
      }
    }
  })

/**
 * Resolve `[[slug]]` and `[label](./rel.nmd)` cross-refs in `body` to inline
 * Notion page links. Hard-fails on a dangling target or a target that has no
 * assigned id yet. `slugMap`: slug → relPath; `idMap`: relPath → page id.
 */
export const resolveCrossRefs = (opts: {
  readonly body: string
  readonly relPath: string
  readonly slugMap: ReadonlyMap<string, string>
  readonly idMap: ReadonlyMap<string, string>
}): Effect.Effect<string, NmdError> =>
  Effect.gen(function* () {
    const urlFor = (relPath: string): string | undefined => {
      const id = opts.idMap.get(relPath)
      return id === undefined ? undefined : pageUrl(id)
    }

    let body = opts.body
    // collect matches against the ORIGINAL body up front; `body` is mutated below.
    const wikiMatches = Array.from(opts.body.matchAll(WIKI_REF))
    const fileMatches = Array.from(opts.body.matchAll(FILE_REF))

    for (const match of wikiMatches) {
      const raw = match[1] ?? ''
      const { slug, label } = splitWikiTarget(raw)
      const targetRel = opts.slugMap.get(slug)
      if (targetRel === undefined) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [[${raw}]] in ${opts.relPath}: no page with slug "${slug}"`,
        })
      }
      const url = urlFor(targetRel)
      if (url === undefined) {
        return yield* new NmdCliError({
          message: `Cross-ref [[${raw}]] in ${opts.relPath} targets ${targetRel} which has no page id yet`,
        })
      }
      body = body.replace(match[0], `[${label}](${url})`)
    }

    for (const match of fileMatches) {
      const text = match[1] ?? ''
      const href = match[2] ?? ''
      const target = fileRefTarget({ relPath: opts.relPath, href })
      const url = urlFor(target)
      if (url === undefined) {
        return yield* new NmdCliError({
          message: `Dangling cross-ref [${text}](${href}) in ${opts.relPath}: no local page at "${target}"`,
        })
      }
      body = body.replace(match[0], `[${text}](${url})`)
    }

    return body
  })
