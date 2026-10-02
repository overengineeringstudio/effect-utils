export class JsonError extends Error {
  readonly _tag = 'JsonError'
  constructor(readonly offset: number, readonly path: string, message: string) { super(`${path} at byte ${offset}: ${message}`) }
}
const scalarString = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) return false }
    else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
/** Parses before schema admission, preserving duplicate keys and number lexemes. */
export const parseJson = (text: string): unknown => {
  let cursor = 0
  const fail = (path: string, message: string): never => { throw new JsonError(cursor, path, message) }
  const space = () => { while (/[\x20\x09\x0a\x0d]/.test(text[cursor] ?? '') && cursor < text.length) cursor++ }
  const string = (path: string): string => {
    const start = cursor++
    while (cursor < text.length) {
      const character = text[cursor++]
      if (character === '"') {
        let value: unknown
        // Only a single string token reaches the native lexer; objects/numbers never do.
        try { value = JSON.parse(text.slice(start, cursor)) } catch { return fail(path, 'Invalid JSON string') }
        if (typeof value !== 'string' || !scalarString(value)) return fail(path, 'Unpaired Unicode surrogate')
        return value
      }
      if (character === '\\') cursor++
    }
    return fail(path, 'Unterminated string')
  }
  const value = (path: string, depth: number): unknown => {
    space()
    const character = text[cursor]
    if (character === '"') return string(path)
    if (character === '{' || character === '[') {
      if (depth >= 128) return fail(path, 'Maximum nesting depth 128 exceeded')
      cursor++; space()
      if (character === '[') {
        const array: unknown[] = []
        if (text[cursor] === ']') { cursor++; return array }
        while (true) {
          array.push(value(`${path}/${array.length}`, depth + 1)); space()
          if (text[cursor] === ']') { cursor++; return array }
          if (text[cursor++] !== ',') return fail(path, 'Expected comma or ]')
        }
      }
      const object: Record<string, unknown> = {}
      const keys = new Set<string>()
      if (text[cursor] === '}') { cursor++; return object }
      while (true) {
        space(); if (text[cursor] !== '"') return fail(path, 'Expected object key')
        const key = string(path)
        if (keys.has(key)) return fail(`${path}/${key}`, 'Duplicate object key')
        keys.add(key); space()
        if (text[cursor++] !== ':') return fail(path, 'Expected colon')
        Object.defineProperty(object, key, { value: value(`${path}/${key}`, depth + 1), enumerable: true, configurable: true, writable: true })
        space()
        if (text[cursor] === '}') { cursor++; return object }
        if (text[cursor++] !== ',') return fail(path, 'Expected comma or }')
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (text.startsWith(token, cursor)) { cursor += token.length; return result }
    }
    const token = text.slice(cursor).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0]
    if (!token) return fail(path, 'Expected JSON value')
    cursor += token.length
    const number = Number(token)
    if (!Number.isFinite(number)) return fail(path, 'Non-finite number')
    if (Number.isInteger(number) && (!Number.isSafeInteger(number) || !/^(0|-?[1-9][0-9]*)$/.test(token))) return fail(path, 'Integer must be safe and canonical decimal; use Wire.U64/I64 for wider integers')
    return number
  }
  const result = value('$', 0); space()
  if (cursor !== text.length) fail('$', 'Trailing input')
  return result
}

/**
 * Canonical control-plane JSON: keys sorted by UTF-16 code unit, except that the first of `tagKeys` present with a
 * string value leads its object. `tagKeys` order is precedence; `Wire.encodeJson` passes the schema's sorted
 * discriminator set, matching the generated Rust `TAG_FIELDS`. Decoders accept any key order.
 */
export const canonicalJson = (input: unknown, tagKeys: readonly string[] = ['_tag']): string => {
  const seen = new Set<object>()
  const encode = (value: unknown, path: string, depth: number): string => {
    const fail = (message: string): never => { throw new JsonError(0, path, message) }
    if (value === null) return 'null'
    if (typeof value === 'string') { if (!scalarString(value)) fail('Unpaired Unicode surrogate'); return JSON.stringify(value) }
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) fail('Non-I-JSON number')
      return JSON.stringify(value)
    }
    if (typeof value !== 'object') return fail('Value is not JSON encodable')
    if (depth >= 128) return fail('Maximum nesting depth 128 exceeded')
    if (seen.has(value)) return fail('Cyclic value')
    seen.add(value)
    let result: string
    if (Array.isArray(value)) result = `[${Array.from(value, (item, index) => encode(item, `${path}/${index}`, depth + 1)).join(',')}]`
    else {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return fail('Expected plain JSON object')
      const tag = tagKeys.find((key) => Object.hasOwn(value, key) && typeof Reflect.get(value, key) === 'string')
      const keys = Object.keys(value).sort((left, right) => left === tag ? -1 : right === tag ? 1 : left < right ? -1 : left > right ? 1 : 0)
      result = `{${keys.map((key) => `${encode(key, path, depth + 1)}:${encode(Reflect.get(value, key), `${path}/${key}`, depth + 1)}`).join(',')}}`
    }
    seen.delete(value)
    return result
  }
  return encode(input, '$', 0)
}
