import { Effect } from 'effect'

import { decodeNmdFrontmatterV1Sync, type NmdFrontmatterV1 } from '@overeng/notion-effect-client'

import { NmdFrontmatterError } from './errors.ts'
import { canonicalizeMarkdown } from './hash.ts'

/** Parsed `.nmd` file split into validated frontmatter and canonical body. */
export interface ParsedNmdFile {
  readonly frontmatter: NmdFrontmatterV1
  readonly body: string
}

const frontmatterEndMarker = '\n---\n'

/** Render strict frontmatter as JSON-compatible YAML to keep parsing dependency-free. */
export const renderNmdFile = (opts: {
  readonly frontmatter: NmdFrontmatterV1
  readonly body: string
}): string =>
  `---\n${JSON.stringify(opts.frontmatter, null, 2)}\n---\n\n${canonicalizeMarkdown(opts.body)}`

/** Parse the local `.nmd` envelope and validate it with the Effect schema. */
export const parseNmdFile = (opts: {
  readonly path: string
  readonly content: string
}): Effect.Effect<ParsedNmdFile, NmdFrontmatterError> =>
  Effect.try({
    try: () => {
      if (opts.content.startsWith('---\n') === false) {
        throw new Error('Expected `.nmd` frontmatter to start with `---`')
      }

      const endIndex = opts.content.indexOf(frontmatterEndMarker, 4)
      if (endIndex === -1) {
        throw new Error('Expected closing `---` frontmatter marker')
      }

      const rawFrontmatter = opts.content.slice(4, endIndex)
      const body = opts.content.slice(endIndex + frontmatterEndMarker.length).replace(/^\n/u, '')
      const decoded = decodeNmdFrontmatterV1Sync(JSON.parse(rawFrontmatter))
      return { frontmatter: decoded, body: canonicalizeMarkdown(body) }
    },
    catch: (cause) =>
      new NmdFrontmatterError({
        path: opts.path,
        cause,
        message: `Failed to parse strict .nmd frontmatter in ${opts.path}`,
      }),
  })
