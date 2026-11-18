import { Schema } from 'effect'

/** Reject duplicate properties before native JSON parsing can erase them. */
const checkProperties = (text: string): void => {
  let index = 0
  const space = (): void => { while (/\s/.test(text[index] ?? '') && index < text.length) index++ }
  const string = (): string => {
    const start = index++
    while (index < text.length) {
      const char = text[index++]
      if (char === '\\') index++
      else if (char === '"') return JSON.parse(text.slice(start, index))
    }
    throw new SyntaxError('Unterminated JSON string')
  }
  const value = (): void => {
    space()
    if (text[index] === '{') {
      index++
      space()
      const keys = new Set<string>()
      if (text[index] === '}') { index++; return }
      while (index < text.length) {
        space()
        if (text[index] !== '"') throw new SyntaxError('Expected JSON property')
        const key = string()
        if (keys.has(key)) throw new SyntaxError('Duplicate JSON property')
        keys.add(key)
        space()
        if (text[index++] !== ':') throw new SyntaxError('Expected JSON colon')
        value()
        space()
        const end = text[index++]
        if (end === '}') return
        if (end !== ',') throw new SyntaxError('Expected JSON comma')
      }
      throw new SyntaxError('Unterminated JSON object')
    }
    if (text[index] === '[') {
      index++
      space()
      if (text[index] === ']') { index++; return }
      while (index < text.length) {
        value()
        space()
        const end = text[index++]
        if (end === ']') return
        if (end !== ',') throw new SyntaxError('Expected JSON comma')
      }
      throw new SyntaxError('Unterminated JSON array')
    }
    if (text[index] === '"') { string(); return }
    const start = index
    while (index < text.length && !/[\s,\]}]/.test(text[index] ?? '')) index++
    if (start === index) throw new SyntaxError('Expected JSON value')
  }
  value()
  space()
  if (index !== text.length) throw new SyntaxError('Trailing JSON data')
}

/** Wire decoder rejects duplicate, unknown and malformed fields, never silently strips them. */
export const decodeJson = <TSchema extends Schema.Top>(schema: TSchema, text: string): TSchema['Type'] => {
  checkProperties(text)
  return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(JSON.parse(text))
}
