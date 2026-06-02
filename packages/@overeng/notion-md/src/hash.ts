import type { Sha256Digest } from '@overeng/notion-effect-client'
import { sha256Hex } from '@overeng/utils'

/**
 * Lightweight line-ending normalizer for body hashing and on-disk storage.
 *
 * Folds CRLF/CR to LF, trims trailing whitespace, ensures a final newline.
 * Block-level *canonicalization* — paragraph unwrap, GFM rules, hyphen
 * bullets — lives in `canonical-markdown.ts` and is applied separately at
 * the Notion wire boundary (push send + post-push compare + pull receive).
 * Two functions, two responsibilities: never collapse them.
 */
export const normalizeMarkdownLineEndings = (markdown: string): string =>
  markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/u, '') + '\n'

/** Compute the canonical body hash used by `.nmd` conflict guards. */
export const sha256Digest = (value: string): Sha256Digest =>
  `sha256:${sha256Hex(value)}` as Sha256Digest
