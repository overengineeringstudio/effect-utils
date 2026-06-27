/**
 * TypeScript types for Notion API create/append payloads.
 *
 * These differ from the read types (`Block`, `TextAnnotations`, `TextRichText`)
 * by omitting server-side fields (`id`, `parent`, timestamps, `plain_text`, `href`)
 * and making annotation fields optional.
 *
 * @module
 */

/** Text annotations for API create payloads. Only fields set to `true` are included. */
export interface TextAnnotationsCreate {
  readonly bold?: boolean
  readonly italic?: boolean
  readonly strikethrough?: boolean
  readonly underline?: boolean
  readonly code?: boolean
  readonly color?: string
}

/** Rich text element for API create payloads (no server-computed `plain_text`/`href`). */
export interface TextRichTextCreate {
  readonly type: 'text'
  readonly text: {
    readonly content: string
    readonly link?: { readonly url: string } | null
  }
  readonly annotations?: TextAnnotationsCreate
}

/** Table row block for API create payloads. */
export interface TableRowBlockCreate {
  readonly object: 'block'
  readonly type: 'table_row'
  readonly table_row: {
    readonly cells: ReadonlyArray<ReadonlyArray<TextRichTextCreate>>
  }
}

/** Block types produced by markdown-to-blocks conversion. */
export type NotionBlockCreate =
  | {
      readonly object: 'block'
      readonly type: 'paragraph'
      readonly paragraph: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
        readonly children?: ReadonlyArray<NotionBlockCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'heading_1'
      readonly heading_1: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'heading_2'
      readonly heading_2: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'heading_3'
      readonly heading_3: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'divider'
      readonly divider: Record<string, never>
    }
  | {
      readonly object: 'block'
      readonly type: 'bulleted_list_item'
      readonly bulleted_list_item: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
        readonly children?: ReadonlyArray<NotionBlockCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'numbered_list_item'
      readonly numbered_list_item: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
        readonly children?: ReadonlyArray<NotionBlockCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'to_do'
      readonly to_do: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
        readonly checked: boolean
        readonly children?: ReadonlyArray<NotionBlockCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'quote'
      readonly quote: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
        readonly children?: ReadonlyArray<NotionBlockCreate>
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'code'
      readonly code: {
        readonly rich_text: ReadonlyArray<TextRichTextCreate>
        readonly language: string
      }
    }
  | {
      readonly object: 'block'
      readonly type: 'table'
      readonly table: {
        readonly table_width: number
        readonly has_column_header: boolean
        readonly has_row_header: boolean
        readonly children: ReadonlyArray<TableRowBlockCreate>
      }
    }
  | TableRowBlockCreate
