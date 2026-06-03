export type NotionUuid = string

const compactNotionUuidPattern = /^[0-9a-f]{32}$/iu
const dashedNotionUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
const compactNotionUuidSearchPattern = /[0-9a-f]{32}/iu
const dashedNotionUuidSearchPattern =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu

/** Return the 32-character compact representation used in Notion URLs. */
export const compactNotionUuid = (id: string): string => id.replaceAll('-', '').toLowerCase()

/** Format a compact 32-character Notion ID as the canonical dashed UUID string. */
export const formatNotionUuid = (compactId: string): NotionUuid | undefined => {
  const normalized = compactId.toLowerCase()
  if (compactNotionUuidPattern.test(normalized) === false) return undefined

  return [
    normalized.slice(0, 8),
    normalized.slice(8, 12),
    normalized.slice(12, 16),
    normalized.slice(16, 20),
    normalized.slice(20),
  ].join('-')
}

/** Parse a Notion UUID from either a dashed ID, compact ID, or Notion URL. */
export const parseNotionUuid = (value: string): NotionUuid | undefined => {
  const trimmed = value.trim()
  if (trimmed === '') return undefined

  if (dashedNotionUuidPattern.test(trimmed) === true) {
    return formatNotionUuid(compactNotionUuid(trimmed))
  }

  if (compactNotionUuidPattern.test(trimmed) === true) {
    return formatNotionUuid(trimmed)
  }

  const dashedMatch = dashedNotionUuidSearchPattern.exec(trimmed)
  if (dashedMatch?.[0] !== undefined) {
    return formatNotionUuid(compactNotionUuid(dashedMatch[0]))
  }

  const compactMatch = compactNotionUuidSearchPattern.exec(trimmed)
  return compactMatch?.[0] === undefined ? undefined : formatNotionUuid(compactMatch[0])
}

/** Build the canonical public Notion object URL for an ID-like value. */
export const notionObjectUrl = (id: string): string => {
  const parsed = parseNotionUuid(id)
  const compactId = parsed === undefined ? compactNotionUuid(id) : compactNotionUuid(parsed)
  return `https://notion.so/${compactId}`
}
