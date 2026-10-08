/** Strict JSON failure carrying the input offset and structural path. */
export class JsonError extends Error {
  readonly _tag = 'JsonError'
  readonly offset: number
  readonly path: string
  // eslint-disable-next-line overeng/named-args -- Preserve the public JsonError positional error constructor.
  constructor(offset: number, path: string, message: string) {
    super(`${path} at byte ${offset}: ${message}`)
    this.offset = offset
    this.path = path
  }
}
/** Checks that a string contains only Unicode scalar values, rejecting unpaired surrogates. */
export const scalarString = (value: string): boolean => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
    } else if (code >= 0xdc00 && code <= 0xdfff) return false
  }
  return true
}
/** Parses before schema admission, preserving duplicate keys and number lexemes. */
export const parseJson = (text: string): unknown => {
  let cursor = 0
  const fail = ({ path, message }: { path: string; message: string }): never => {
    throw new JsonError(cursor, path, message)
  }
  const space = () => {
    // eslint-disable-next-line eslint/no-control-regex -- JSON whitespace is exactly space, tab, LF and CR; these control characters are intentional.
    while (/[\x20\x09\x0a\x0d]/.test(text[cursor] ?? '') === true && cursor < text.length) cursor++
  }
  const string = (path: string): string => {
    const start = cursor++
    while (cursor < text.length) {
      const character = text[cursor++]
      if (character === '"') {
        let value: unknown
        // Only a single string token reaches the native lexer; objects/numbers never do.
        try {
          value = JSON.parse(text.slice(start, cursor))
        } catch {
          return fail({ path, message: 'Invalid JSON string' })
        }
        if (typeof value !== 'string' || scalarString(value) === false)
          return fail({ path, message: 'Unpaired Unicode surrogate' })
        return value
      }
      if (character === '\\') cursor++
    }
    return fail({ path, message: 'Unterminated string' })
  }
  const value = ({ path, depth }: { path: string; depth: number }): unknown => {
    space()
    const character = text[cursor]
    if (character === '"') return string(path)
    if (character === '{' || character === '[') {
      if (depth >= 128) return fail({ path, message: 'Maximum nesting depth 128 exceeded' })
      cursor++
      space()
      if (character === '[') {
        const array: unknown[] = []
        if (text[cursor] === ']') {
          cursor++
          return array
        }
        while (true) {
          array.push(value({ path: `${path}/${array.length}`, depth: depth + 1 }))
          space()
          if (text[cursor] === ']') {
            cursor++
            return array
          }
          if (text[cursor++] !== ',') return fail({ path, message: 'Expected comma or ]' })
        }
      }
      const object: Record<string, unknown> = {}
      const keys = new Set<string>()
      if (text[cursor] === '}') {
        cursor++
        return object
      }
      while (true) {
        space()
        if (text[cursor] !== '"') return fail({ path, message: 'Expected object key' })
        const key = string(path)
        if (keys.has(key) === true)
          return fail({ path: `${path}/${key}`, message: 'Duplicate object key' })
        keys.add(key)
        space()
        if (text[cursor++] !== ':') return fail({ path, message: 'Expected colon' })
        Object.defineProperty(object, key, {
          value: value({ path: `${path}/${key}`, depth: depth + 1 }),
          enumerable: true,
          configurable: true,
          writable: true,
        })
        space()
        if (text[cursor] === '}') {
          cursor++
          return object
        }
        if (text[cursor++] !== ',') return fail({ path, message: 'Expected comma or }' })
      }
    }
    for (const [token, result] of [
      ['true', true],
      ['false', false],
      ['null', null],
    ] as const) {
      if (text.startsWith(token, cursor) === true) {
        cursor += token.length
        return result
      }
    }
    const token = text
      .slice(cursor)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0]
    if (token === undefined || token === '') return fail({ path, message: 'Expected JSON value' })
    cursor += token.length
    const number = Number(token)
    if (Number.isFinite(number) === false) return fail({ path, message: 'Non-finite number' })
    if (
      Number.isInteger(number) === true &&
      (Number.isSafeInteger(number) === false || /^(0|-?[1-9][0-9]*)$/.test(token) === false)
    )
      return fail({
        path,
        message:
          'Integer must be safe and canonical decimal; use a bounded Schema.BigInt for wider integers',
      })
    return number
  }
  const result = value({ path: '$', depth: 0 })
  space()
  if (cursor !== text.length) fail({ path: '$', message: 'Trailing input' })
  return result
}

/**
 * Canonical control-plane JSON: keys sorted by UTF-16 code unit, except that the first of `tagKeys` present with a
 * string value leads its object. `tagKeys` order is precedence; `ContractJson.encode` passes the schema's sorted
 * discriminator set, matching the generated Rust `TAG_FIELDS`. Decoders accept any key order.
 */
// eslint-disable-next-line overeng/named-args -- Preserve the public canonicalJson positional SDK signature.
export const canonicalJson = (input: unknown, tagKeys: readonly string[] = ['_tag']): string => {
  const seen = new Set<object>()
  const encode = ({
    value,
    path,
    depth,
  }: {
    value: unknown
    path: string
    depth: number
  }): string => {
    const fail = (message: string): never => {
      throw new JsonError(0, path, message)
    }
    if (value === null) return 'null'
    if (typeof value === 'string') {
      if (scalarString(value) === false) fail('Unpaired Unicode surrogate')
      return JSON.stringify(value)
    }
    if (typeof value === 'boolean') return value === true ? 'true' : 'false'
    if (typeof value === 'number') {
      if (
        Number.isFinite(value) === false ||
        Object.is(value, -0) === true ||
        (Number.isInteger(value) === true && Number.isSafeInteger(value) === false)
      )
        fail('Non-I-JSON number')
      return JSON.stringify(value)
    }
    if (typeof value !== 'object') return fail('Value is not JSON encodable')
    if (depth >= 128) return fail('Maximum nesting depth 128 exceeded')
    if (seen.has(value) === true) return fail('Cyclic value')
    seen.add(value)
    let result: string
    if (Array.isArray(value) === true)
      result = `[${Array.from(value, (item, index) => encode({ value: item, path: `${path}/${index}`, depth: depth + 1 })).join(',')}]`
    else {
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        return fail('Expected plain JSON object')
      const tag = tagKeys.find(
        (key) => Object.hasOwn(value, key) && typeof Reflect.get(value, key) === 'string',
      )
      // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
      const keys = Object.keys(value).sort((left, right) =>
        left === tag ? -1 : right === tag ? 1 : left < right ? -1 : left > right ? 1 : 0,
      )
      result = `{${keys.map((key) => `${encode({ value: key, path, depth: depth + 1 })}:${encode({ value: Reflect.get(value, key), path: `${path}/${key}`, depth: depth + 1 })}`).join(',')}}`
    }
    seen.delete(value)
    return result
  }
  return encode({ value: input, path: '$', depth: 0 })
}
