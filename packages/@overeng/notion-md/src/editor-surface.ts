import { Effect } from 'effect'

import type { Sha256Digest } from '@overeng/notion-effect-client'

import { NmdInvalidDocumentError } from './errors.ts'
import { normalizeMarkdownLineEndings, sha256Digest } from './hash.ts'

/**
 * Shared title↔H1 splice and base-hash logic for the editor surfaces
 * (`cat` / `put` / `edit`).
 *
 * Default mode presents a Notion page as a leading `# <title>` line, a blank
 * line, then the body Markdown (decision 0001). The title is a *presentation*
 * affordance only: on write it is transport-routed through the typed page API,
 * never as a body block. The base hash covers the writable surface — title +
 * body together (decisions 0001/0006) — so a title-only remote change still
 * trips the guard.
 *
 * The exact serialized bytes are load-bearing: they are the cross-machine
 * optimistic-concurrency token (`cat` prints the hash; `put` compares it) and
 * the missing-title-H1 refusal anchor, so `serialize ∘ parse` must round-trip
 * exactly (spec "Edge behavior").
 *
 * Hosted-media URL canonicalization (decision 0007, impl-delta Group B) is the
 * one piece not applied here: on representable non-media pages the body URLs are
 * stable, so the serialized form is already idempotent. When Group B lands, the
 * media-canonicalized body flows in through `body` unchanged — this module
 * serializes whatever body it is given.
 */

/** A default-mode editor document: the page title plus its Markdown body. */
export interface TitleBodyDocument {
  readonly title: string
  readonly body: string
}

/**
 * Serialize a title + body to the canonical default-mode editor byte form.
 *
 * - titled + body: `# <title>\n\n<body>` (body ends in `\n`)
 * - titled + empty body: `# <title>\n`
 * - untitled (empty title) + empty body: `# \n`
 *
 * The body is line-ending normalized (CRLF→LF, trailing whitespace trimmed, a
 * single trailing newline). A leading `# …` *inside* the body is ordinary
 * content and is preserved verbatim — only line 1 is the title.
 */
export const serializeTitleBody = (doc: TitleBodyDocument): string => {
  const body = normalizeMarkdownLineEndings(doc.body)
  const bodyIsEmpty = body === '\n'
  return bodyIsEmpty ? `# ${doc.title}\n` : `# ${doc.title}\n\n${body}`
}

/**
 * Parse a default-mode editor buffer back into title + body.
 *
 * Line 1 must be a `# ` ATX heading; its remainder (after `# `) is the title
 * verbatim (empty → untitled). Everything after the first blank separator line
 * is the body verbatim — including a body that starts with its own `# …`
 * heading (the title/body H1 sharp edge: line 1 wins, the rest is body). A line
 * 1 that is not a `# ` heading is refused (exit 5) rather than guessed, because
 * silently emptying a title is property-level data loss (T03).
 */
export const parseTitleBody = (opts: {
  readonly buffer: string
  readonly pageId?: string
}): Effect.Effect<TitleBodyDocument, NmdInvalidDocumentError> =>
  Effect.gen(function* () {
    const normalized = opts.buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    const newlineIndex = normalized.indexOf('\n')
    const firstLine = newlineIndex === -1 ? normalized : normalized.slice(0, newlineIndex)

    if (firstLine !== '#' && firstLine.startsWith('# ') === false) {
      return yield* new NmdInvalidDocumentError({
        ...(opts.pageId === undefined ? {} : { page_id: opts.pageId }),
        message:
          'Default-mode editor buffer must start with a `# <title>` heading on line 1; ' +
          'refusing to push because silently emptying the page title is property-level data loss. ' +
          'Add a `# Title` first line (use `# ` for an untitled page).',
      })
    }

    // `# foo` → title `foo`; bare `#` or `# ` → untitled (empty title).
    const title = firstLine === '#' ? '' : firstLine.slice(2)

    const rest = newlineIndex === -1 ? '' : normalized.slice(newlineIndex + 1)
    // A single blank separator line between the title and the body is consumed.
    const body = rest.startsWith('\n') === true ? rest.slice(1) : rest

    return { title, body: body === '' ? '' : normalizeMarkdownLineEndings(body) }
  })

/**
 * The editor base hash: `sha256` over the canonical default-mode serialization
 * of title + body (decisions 0002/0006). This is the value `cat` prints to
 * stderr and `put` compares against `--base-hash`. A client must reproduce it
 * from the canonical body the first pull returned — never recompute it locally
 * over a pre-canonical editable buffer (spec "Push Strategy and Canonical Base").
 */
export const editorBaseHash = (doc: TitleBodyDocument): Sha256Digest =>
  sha256Digest(serializeTitleBody(doc))
