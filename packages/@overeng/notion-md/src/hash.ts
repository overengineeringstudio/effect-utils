import type { Sha256Digest } from '@overeng/notion-effect-client'
import { sha256Hex } from '@overeng/utils'

/**
 * Lightweight line-ending normalizer for body hashing and on-disk storage.
 *
 * Folds CRLF/CR to LF, trims trailing whitespace, ensures a final newline.
 * Block-level *canonicalization* — paragraph unwrap, GFM rules, hyphen bullets,
 * tight lists — is `canonicalizeBlockMarkdown` in `@overeng/notion-effect-client`
 * (beside the renderer it canonicalizes), applied at BOTH Notion wire boundaries:
 * pull receive (`observeFromSnapshots` canonicalizes the rendered body at the
 * source) and push send + post-push compare (decision 0019). This line-ending
 * normalize is a *sub-step* of that canonical form, but is also used on its own
 * for on-disk / title-frame / hash-prep where a full re-canonicalization would be
 * wrong (it must preserve verbatim line/substring identity). Two responsibilities,
 * one a step of the other: never substitute one for the other.
 */
export const normalizeMarkdownLineEndings = (markdown: string): string =>
  markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/u, '') + '\n'

/** Compute the canonical body hash used by `.nmd` conflict guards. */
export const sha256Digest = (value: string): Sha256Digest =>
  `sha256:${sha256Hex(value)}` as Sha256Digest

/**
 * Drop block-level `<page>…</page>` child anchors from a body and collapse the
 * gap they leave behind.
 *
 * Derived `<page>` anchors are re-emitted on every push and Notion auto-appends
 * them, so they are not user content: change detection must ignore them, and the
 * tree engine strips them before recording the on-disk / baseline body. Besides
 * filtering the anchor lines we line-ending normalize and collapse the runs of
 * blank lines an anchor leaves between two blocks (`\n{3,}` → `\n\n`), so the
 * result is stable whether or not an anchor sat between blocks — the single
 * definition both the sync change-detection compare and the tree baseline use.
 */
export const stripChildAnchors = (body: string): string =>
  normalizeMarkdownLineEndings(
    body
      .split('\n')
      .filter((line) => /^\s*<page\b[^>]*>.*<\/page>\s*$/u.test(line) === false)
      .join('\n')
      .replace(/\n{3,}/gu, '\n\n')
      .replace(/\n+$/u, '\n'),
  )
