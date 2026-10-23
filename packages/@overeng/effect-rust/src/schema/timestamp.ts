import { Schema, type SchemaAST } from 'effect'

/** Built-in identity, never an annotation-based authorization of opaque code. */
export const isTimestampAST = (ast: SchemaAST.AST): boolean =>
  ast._tag === 'Declaration' &&
  ast.run === Schema.DateTimeUtc.ast.run &&
  ast.encoding === Schema.DateTimeUtc.ast.encoding &&
  Schema.resolveAnnotations(Schema.make(ast))?.toCodecJson ===
    Schema.resolveAnnotations(Schema.DateTimeUtc)?.toCodecJson
/** Calendar-valid RFC3339 with an explicit offset and no submillisecond loss. */
export const validTimestampMillis = (text: string): boolean => {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(text)
  if (match === null) return false
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number)
  const fraction = match[7] ?? ''
  if (fraction.length > 3 && /[1-9]/.test(fraction.slice(3)) === true) return false
  const days = [
    31,
    year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ]
  const zone = match[8]!
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return false
  return (
    month! >= 1 &&
    month! <= 12 &&
    day! >= 1 &&
    day! <= days[month! - 1]! &&
    hour! <= 23 &&
    minute! <= 59 &&
    second! <= 59 &&
    Number.isFinite(Date.parse(text)) &&
    /^\d{4}-/.test(new Date(text).toISOString())
  )
}
