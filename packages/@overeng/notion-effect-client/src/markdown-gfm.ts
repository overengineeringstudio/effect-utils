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

const pushProcessorData = <TValue>({
  data,
  key,
  extensions,
}: {
  data: Record<string, unknown>
  key: string
  extensions: ReadonlyArray<TValue>
}): void => {
  const current = (data[key] ??= []) as Array<TValue>
  current.push(...extensions)
}

/**
 * Use only the GFM constructs Notion-flavored Markdown needs here. The bundled
 * `remark-gfm` also enables autolink literals, which rewrites plain URL/email-
 * shaped text into angle autolinks (`https://x.y` -> `<https://x.y>`). That is
 * lossy for Notion preview-link text and makes edge cases like `0@.A`
 * non-idempotent (`<0@.A>` -> `<<0@.A>>`).
 */
export const remarkNotionGfm = function (this: Processor): void {
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
