# Canonical Notion block types

Source: https://developers.notion.com/reference/block (fetched 2026-04-19) + linked per-type pages.

Legend: `C` = creatable via `PATCH /blocks/:id/children`, `R` = readable, `C*` = creation only via dedicated endpoint (not append-block-children), `C-` = no creation at all (read-only surface).

- `paragraph` — C, R — rich_text, color, children (nested blocks)
- `heading_1` — C, R — rich_text, color, is_toggleable, children (when toggleable)
- `heading_2` — C, R — rich_text, color, is_toggleable, children (when toggleable)
- `heading_3` — C, R — rich_text, color, is_toggleable, children (when toggleable)
- `heading_4` — C, R — rich_text, color, is_toggleable, children (when toggleable) [newer block]
- `quote` — C, R — rich_text, color, children
- `callout` — C, R — rich_text, icon ({emoji|external|custom_emoji}), color, children
- `code` — C, R — rich_text, caption (rich_text), language
- `bulleted_list_item` — C, R — rich_text, color, children
- `numbered_list_item` — C, R — rich_text, color, list_start_index, list_format, children
- `to_do` — C, R — rich_text, checked, color, children
- `toggle` — C, R — rich_text, color, children
- `image` — C, R — type ('external'|'file'|'file_upload'), external.url / file.url / file_upload.id, caption
- `video` — C, R — type, external/file/file_upload, caption
- `audio` — C, R — type, external/file/file_upload, caption
- `file` — C, R — type, external/file/file_upload, caption, name
- `pdf` — C, R — type, external/file/file_upload, caption
- `embed` — C, R — url, caption
- `bookmark` — C, R — url, caption
- `table` — C, R — table_width, has_column_header, has_row_header, children (table_row[])
- `table_row` — C, R — cells (rich_text[][])
- `column_list` — C, R — children (column[])
- `column` — C, R — width_ratio, children
- `divider` — C, R — (empty)
- `table_of_contents` — C, R — color
- `breadcrumb` — C, R — (empty)
- `tab` — C, R — children (paragraphs with icons) [newer block]
- `synced_block` — C, R — synced_from ({block_id} | null for original), children
- `child_page` — C* (via pages.create), R — title
- `child_database` — C* (via databases.create), R — title
- `equation` — C, R — expression
- `template` — C- (creation deprecated 2023-03-27), R — rich_text, children
- `link_preview` — C-, R — url
- `link_to_page` — C, R — type ('page_id'|'database_id'|'comment_id'), page_id/database_id/comment_id
- `meeting_notes` — C-, R — title, status, children, calendar_event, recording [newer block]
- `unsupported` — C-, R — (opaque; returned for unknown server-side types)
