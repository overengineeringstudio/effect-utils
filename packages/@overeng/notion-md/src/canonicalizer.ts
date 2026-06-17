import { canonicalizeSemanticMarkdown } from './canonical-markdown.ts'
import { sha256Digest } from './hash.ts'

/**
 * Compatibility surface for the v-next reconcile core. The canonical Markdown
 * implementation itself lives in `@overeng/notion-effect-client`; this adapter
 * selects its semantic reconciliation policy, which folds Notion round-trip
 * cosmetics without weakening the wire/on-disk body canonicalizer.
 */
export const canonicalize = canonicalizeSemanticMarkdown

/** Two bodies are semantically equal when their semantic canonical forms match. */
export const semanticEqual = (opts: { readonly a: string; readonly b: string }): boolean =>
  canonicalize(opts.a) === canonicalize(opts.b)

/** Stable content identity under the semantic canonical body form. */
export const canonicalHash = (markdown: string): string => sha256Digest(canonicalize(markdown))
