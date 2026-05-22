import { createHash } from 'node:crypto'

import type { Sha256Digest } from '@overeng/notion-effect-client'

/** Canonicalize Markdown bytes before hashing or writing. */
export const canonicalizeMarkdown = (markdown: string): string =>
  markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\s+$/u, '') + '\n'

/** Compute the canonical body hash used by `.nmd` conflict guards. */
export const sha256Digest = (value: string): Sha256Digest =>
  `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest
