import { createHash } from 'node:crypto'

import type { Sha256Digest } from '@overeng/notion-effect-client'

/*
 * Lightweight canonicalization used for body hashing and storage on disk.
 *
 * Normalizes line endings, trims trailing whitespace, and ensures a final
 * newline. Block-level canonicalization (paragraph unwrap, list rules,
 * emphasis markers) is applied separately at the Notion wire boundary in
 * `live.ts` so that the merge engine and storage layer keep their existing
 * line-oriented semantics.
 */
export const canonicalizeMarkdown = (markdown: string): string =>
  markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/u, '') + '\n'

/** Compute the canonical body hash used by `.nmd` conflict guards. */
export const sha256Digest = (value: string): Sha256Digest =>
  `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
