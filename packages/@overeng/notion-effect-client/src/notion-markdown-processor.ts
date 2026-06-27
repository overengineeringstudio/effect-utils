import {
  gfmStrikethroughFromMarkdown,
  gfmStrikethroughToMarkdown,
} from 'mdast-util-gfm-strikethrough'
import { gfmTableFromMarkdown, gfmTableToMarkdown } from 'mdast-util-gfm-table'
import {
  gfmTaskListItemFromMarkdown,
  gfmTaskListItemToMarkdown,
} from 'mdast-util-gfm-task-list-item'
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough'
import { gfmTable } from 'micromark-extension-gfm-table'
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item'
import type { Processor } from 'unified'

/**
 * Use only the GFM constructs Notion-flavored Markdown needs here. The bundled
 * `remark-gfm` also enables autolink literals, which rewrites plain URL/email-
 * shaped text into angle autolinks (`https://x.y` -> `<https://x.y>`). That is
 * lossy for Notion preview-link text and makes edge cases like `0@.A`
 * non-idempotent (`<0@.A>` -> `<<0@.A>>`).
 */
export const notionMarkdownGfm = function (this: Processor): void {
  const data = this.data() as Record<string, unknown>
  pushProcessorData({
    data,
    key: 'micromarkExtensions',
    extensions: [gfmTable(), gfmTaskListItem(), gfmStrikethrough()],
  })
  pushProcessorData({
    data,
    key: 'fromMarkdownExtensions',
    extensions: [
      gfmTableFromMarkdown(),
      gfmTaskListItemFromMarkdown(),
      gfmStrikethroughFromMarkdown(),
    ],
  })
  pushProcessorData({
    data,
    key: 'toMarkdownExtensions',
    extensions: [gfmTableToMarkdown(), gfmTaskListItemToMarkdown(), gfmStrikethroughToMarkdown()],
  })
}

/** Options accepted by {@link pushProcessorData}. */
export interface PushProcessorDataOptions<A> {
  /** Mutable unified processor data bag. */
  readonly data: Record<string, unknown>
  /** Data key that stores the extension array. */
  readonly key: string
  /** Extensions to append to the processor data key. */
  readonly extensions: ReadonlyArray<A>
}

/** Append unified parser/stringifier extensions to a processor data key. */
export const pushProcessorData = <A>({
  data,
  key,
  extensions,
}: PushProcessorDataOptions<A>): void => {
  const current = (data[key] ??= []) as Array<A>
  current.push(...extensions)
}

/** Normalize Markdown line endings before parsing. */
export const normalizeMarkdownLineEndings = (markdown: string): string =>
  markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

/** Canonical Markdown stringifier options shared by Notion Markdown processors. */
export const markdownStringifyOptions = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  fence: '`',
  fences: true,
  listItemIndent: 'one',
  resourceLink: true,
  rule: '-',
  setext: false,
  tightDefinitions: true,
} as const
