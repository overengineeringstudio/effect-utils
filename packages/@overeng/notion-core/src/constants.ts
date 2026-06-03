/** Current Notion API version used by the Notion package family. */
export const NOTION_API_VERSION = '2026-03-11'

/** Base URL for Notion API requests. */
export const NOTION_API_BASE_URL = 'https://api.notion.com/v1'

/** Base URL for Notion API documentation reference pages. */
export const NOTION_DOCS_BASE = 'https://developers.notion.com/reference'

/** A Notion API version string in the documented YYYY-MM-DD shape. */
export type NotionApiVersion = `${number}-${number}-${number}`

export type ParsedNotionApiVersion = {
  readonly value: NotionApiVersion
  readonly year: number
  readonly month: number
  readonly day: number
}

const notionApiVersionPattern = /^(\d{4})-(\d{2})-(\d{2})$/u

const isLeapYear = (year: number): boolean =>
  year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0)

const daysInMonth = (year: number, month: number): number | undefined => {
  switch (month) {
    case 1:
    case 3:
    case 5:
    case 7:
    case 8:
    case 10:
    case 12:
      return 31
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    case 2:
      return isLeapYear(year) ? 29 : 28
    default:
      return undefined
  }
}

/** Parse and validate a Notion API version date without relying on runtime time zones. */
export const parseNotionApiVersion = (value: string): ParsedNotionApiVersion | undefined => {
  const match = notionApiVersionPattern.exec(value)
  if (match === null) return undefined

  const [, yearText, monthText, dayText] = match
  if (yearText === undefined || monthText === undefined || dayText === undefined) {
    return undefined
  }

  const year = Number(yearText)
  const month = Number(monthText)
  const day = Number(dayText)
  const maxDay = daysInMonth(year, month)
  if (maxDay === undefined || day < 1 || day > maxDay) return undefined

  return { value: value as NotionApiVersion, year, month, day }
}

/** Check whether a string is a valid Notion API version date. */
export const isNotionApiVersion = (value: string): value is NotionApiVersion =>
  parseNotionApiVersion(value) !== undefined

/** Check whether a version string matches the core package's pinned API version. */
export const isSupportedNotionApiVersion = (
  value: string,
): value is typeof NOTION_API_VERSION => value === NOTION_API_VERSION

/** Compare two valid Notion API version strings. Returns undefined when either side is invalid. */
export const compareNotionApiVersions = (
  left: string,
  right: string,
): -1 | 0 | 1 | undefined => {
  const parsedLeft = parseNotionApiVersion(left)
  const parsedRight = parseNotionApiVersion(right)
  if (parsedLeft === undefined || parsedRight === undefined) return undefined

  const leftParts = [parsedLeft.year, parsedLeft.month, parsedLeft.day] as const
  const rightParts = [parsedRight.year, parsedRight.month, parsedRight.day] as const

  for (const [index, leftPart] of leftParts.entries()) {
    const rightPart = rightParts[index]
    if (rightPart === undefined) return undefined
    if (leftPart < rightPart) return -1
    if (leftPart > rightPart) return 1
  }

  return 0
}

/** Resolve a Notion docs reference path or fragment to a full docs URL. */
export const resolveDocsUrl = (path: string): string => {
  if (/^https?:\/\//u.test(path) === true) return path

  const normalizedPath = path.replace(/^\/+/u, '')
  return normalizedPath === '' ? NOTION_DOCS_BASE : `${NOTION_DOCS_BASE}/${normalizedPath}`
}
