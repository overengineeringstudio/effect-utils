import { InvalidKdlError } from './parser/internal-error.ts'
import { isIdentifierChar, isInvalidCharacter } from './parser/tokenize/types.ts'
import type { Location, Token, TokenType } from './parser/token.ts'

const escapedCodePointsInStringify = new Map<number, string>([
  ...Array.from(
    { length: 0x20 },
    (_, codePoint): [number, string] => [
      codePoint,
      `\\u{${codePoint.toString(16).padStart(2, '0')}}`,
    ],
  ),
  [0x7f, '\\u{7f}'],
  [0x200e, '\\u{200e}'],
  [0x200f, '\\u{200f}'],
  [0x202a, '\\u{202a}'],
  [0x202b, '\\u{202b}'],
  [0x202c, '\\u{202c}'],
  [0x202d, '\\u{202d}'],
  [0x202e, '\\u{202e}'],
  [0x2066, '\\u{2066}'],
  [0x2067, '\\u{2067}'],
  [0x2068, '\\u{2068}'],
  [0x2069, '\\u{2069}'],
  [0xfeff, '\\u{feff}'],
  [0x22, '\\"'],
  [0x5c, '\\\\'],
  [0x0a, '\\n'],
  [0x0b, '\\u{0b}'],
  [0x0c, '\\f'],
  [0x0d, '\\r'],
  [0x85, '\\u{85}'],
  [0x2028, '\\u{2028}'],
  [0x2029, '\\u{2029}'],
  [0x08, '\\b'],
  [0x09, '\\t'],
])

export const stringifyString = (string: string): string => {
  let isValidBareIdentifier = !(
    string === '' ||
    string === 'true' ||
    string === 'false' ||
    string === 'null' ||
    string === 'inf' ||
    string === '-inf' ||
    string === 'nan' ||
    /^[+-]?\.?[0-9]/.test(string)
  )

  let stringified = '"'

  for (const part of string) {
    const codePoint = part.codePointAt(0)!

    const escape = escapedCodePointsInStringify.get(codePoint)
    if (escape) {
      isValidBareIdentifier = false
      stringified += escape
    } else if (isInvalidCharacter(codePoint)) {
      throw new InvalidKdlError(
        `Codepoint \\u{${codePoint.toString(16)}} cannot be present in a KDL string, even escaped in its \\u{} form`,
      )
    } else {
      if (!isIdentifierChar(codePoint)) {
        isValidBareIdentifier = false
      }
      stringified += part
    }
  }

  if (isValidBareIdentifier) {
    return string
  }

  return stringified + '"'
}

const escapedValues = new Map<string, string>([
  ['\\n', '\n'],
  ['\\r', '\r'],
  ['\\t', '\t'],
  ['\\\\', '\\'],
  ['\\"', '"'],
  ['\\b', '\b'],
  ['\\f', '\f'],
  ['\\s', ' '],
])

export const reNewline = /\x0D\x0A|[\x0A\x0B\x0C\x0D\x85\u2028\u2029]/
const reAllNewline = /\x0D\x0A|[\x0A\x0B\x0C\x0D\x85\u2028\u2029]/g
const reUnescapedNewline =
  /(?:^|[^\\\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\x0A\x0B\x0C\x0D\x85\u2028\u2029])(?:\\\\)*[\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\x0A\x0B\x0C\x0D\x85\u2028\u2029]*(\x0D\x0A|[\x0A\x0B\x0C\x0D\x85\u2028\u2029])/s
const reAllUnescapedNewline =
  /(?:^|[^\\\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\x0A\x0B\x0C\x0D\x85\u2028\u2029])(?:\\\\)*[\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\x0A\x0B\x0C\x0D\x85\u2028\u2029]*(\x0D\x0A|[\x0A\x0B\x0C\x0D\x85\u2028\u2029])/dgs

const reFinalWhitespaceLine =
  /[\x0A\x0B\x0C\x0D\x85\u2028\u2029]([\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*)$/
const reFinalWhitespaceLineIncludingEscapes =
  /(?:^|[^\\\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000])(?:\\\\)*[\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*[\x0A\x0B\x0C\x0D\x85\u2028\u2029]([\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*)(?:\\[\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*)*$/
const reNewlineWithLeadingSpace =
  /(\x0D\x0A|[\x0A\x0B\x0C\x0D\x85\u2028\u2029])([\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*)([^\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]?)/g
const reLastNonWhitespaceOrNewline =
  /([^\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000])[\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*$/

const computeStartLocation = (token: Token, value: string, offset: number): Location => {
  let preludeLength = 1
  const type: TokenType = token.type
  if (type === 'multiline-quoted-string') {
    preludeLength = 3
  } else if (type === 'raw-string') {
    preludeLength = token.text.indexOf('"') + 1
  } else if (type === 'multiline-raw-string') {
    preludeLength = token.text.indexOf('"') + 3
  }

  const linesBeforeOffset = value.slice(0, offset).split(reNewline)

  return {
    offset: token.start.offset + preludeLength + offset,
    line: token.start.line + (linesBeforeOffset.length - 1),
    column:
      linesBeforeOffset.length === 1
        ? token.start.column + preludeLength + offset
        : 1 + linesBeforeOffset[linesBeforeOffset.length - 1]!.length,
  }
}

const replaceEscape = (
  errors: Error[],
  value: string,
  token: Token,
  escape: string,
  unicode: string | undefined,
  invalidUnicode: string | undefined,
  whitespace: string | undefined,
  offset: number,
): string => {
  if (whitespace) {
    return ''
  }

  if (invalidUnicode) {
    const multiline = token.text.startsWith('"""')
    const linesBefore = value.slice(0, offset).split(reNewline)
    const start = {
      offset: token.start.offset + (multiline ? 3 : 1) + offset,
      line: token.start.line + (linesBefore.length - 1),
      column:
        linesBefore.length === 1
          ? token.start.column + (multiline ? 3 : 1) + offset
          : linesBefore.at(-1)!.length,
    }
    const end = {
      offset: start.offset + escape.length,
      line: start.line,
      column: start.column + escape.length,
    }

    if (!invalidUnicode.startsWith('{')) {
      errors.push(
        new InvalidKdlError(
          String.raw`Invalid unicode escape "\u${invalidUnicode}", did you forget to use {}? "\u{${invalidUnicode}}"`,
          { token, start, end },
        ),
      )
    } else {
      errors.push(
        new InvalidKdlError(
          String.raw`Invalid unicode escape "\u${invalidUnicode.endsWith('}') ? invalidUnicode : `${invalidUnicode}...`}"`,
          { token, start, end },
        ),
      )
    }

    return ''
  } else if (unicode) {
    const codePoint = parseInt(unicode, 16)

    if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
      errors.push(
        new InvalidKdlError(
          String.raw`Invalid unicode escape "\u{${unicode}}, only scalar values can be added using an escape`,
          { token },
        ),
      )
    }

    return String.fromCodePoint(codePoint)
  } else {
    const replacement = escapedValues.get(escape)

    if (replacement == null) {
      errors.push(
        new InvalidKdlError(
          escape.length < 2
            ? 'Invalid whitespace escape at the end of a string'
            : `Invalid escape "${escape}"`,
          { token },
        ),
      )
      return ''
    }

    return replacement
  }
}

export const postProcessRawStringValue = (errors: Error[], value: string, token: Token): string => {
  let newlineMatch: RegExpExecArray | null
  while ((newlineMatch = reAllNewline.exec(value))) {
    const start = computeStartLocation(token, value, newlineMatch.index)

    errors.push(
      new InvalidKdlError(
        'Raw strings with single quotes cannot contain any unescaped newlines, use triple-quotes for multiline strings',
        {
          token,
          start,
          end: {
            offset: start.offset + newlineMatch[0].length,
            line: start.line + 1,
            column: 1,
          },
        },
      ),
    )
  }

  return value
}

export const postProcessMultilineRawStringValue = (
  errors: Error[],
  value: string,
  token: Token,
): string => {
  if (!reNewline.test(value)) {
    errors.push(
      new InvalidKdlError('Raw strings with three quotes must be multiline strings', { token }),
    )
    return value
  }

  if (!reNewline.test(value[0]!)) {
    errors.push(
      new InvalidKdlError('Multi-line strings must start with a newline', { token }),
    )
    return value
  }

  const lastLine = reFinalWhitespaceLine.exec(value)?.[1]

  if (lastLine == null) {
    errors.push(
      new InvalidKdlError('The final line in a multiline string may only contain whitespace', { token }),
    )
    return value
  }

  return value
    .replace(
      reNewlineWithLeadingSpace,
      (_: string, newline: string, leadingWhitespace: string, firstContentCharacter: string, offset: number) => {
        if (!firstContentCharacter) {
          return '\n'
        }

        if (!leadingWhitespace.startsWith(lastLine)) {
          const start = computeStartLocation(token, value, offset + newline.length)

          errors.push(
            new InvalidKdlError(
              'Every non-blank line of a multi-line string must start with the offset defined by the last line of the string',
              {
                token,
                start,
                end: {
                  offset: start.offset + lastLine.length,
                  line: start.line,
                  column: start.column + lastLine.length,
                },
              },
            ),
          )

          return '\n'
        }

        return '\n' + leadingWhitespace.slice(lastLine.length) + firstContentCharacter
      },
    )
    .slice(1, -1)
}

const reSingleLineEscape =
  /\\(?:$|u\{(0[0-9a-fA-F]{0,5}|10[0-9a-fA-F]{4}|[1-9a-fA-F][0-9a-fA-F]{0,4})\}|u(\{[^}]{1,6}\}?|[0-9a-fA-F]{1,5}|10[0-9a-fA-F]{4})|([\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+)|.)/g

export const postProcessStringValue = (errors: Error[], value: string, token: Token): string => {
  let unescapedNewlineMatch: RegExpExecArray | null
  while ((unescapedNewlineMatch = reAllUnescapedNewline.exec(value))) {
    const indices = (unescapedNewlineMatch as RegExpExecArray & { indices: number[][] }).indices
    const start = computeStartLocation(token, value, indices[1]![0]!)

    errors.push(
      new InvalidKdlError(
        'Strings with single quotes cannot contain any unescaped newlines, use triple-quotes for multiline strings',
        {
          token,
          start,
          end: {
            offset: start.offset + unescapedNewlineMatch[1]!.length,
            line: start.line + 1,
            column: 1,
          },
        },
      ),
    )
  }

  return value.replace(
    reSingleLineEscape,
    (escape: string, unicode: string | undefined, invalidUnicode: string | undefined, whitespace: string | undefined, offset: number) =>
      replaceEscape(errors, value, token, escape, unicode, invalidUnicode, whitespace, offset),
  )
}

const reMultiLineNewLineWithWhitespaceOrEscape =
  /(\x0D\x0A|[\x0A\x0B\x0C\x0D\x85\u2028\u2029])([\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]*)|\\(?:$|u\{(0[0-9a-fA-F]{0,5}|10[0-9a-fA-F]{4}|[1-9a-fA-F][0-9a-fA-F]{0,4})\}|u(\{[^}]{1,6}\}?|[0-9a-fA-F]{1,5}|10[0-9a-fA-F]{4})|([\x0A\x0B\x0C\x0D\x85\u2028\u2029\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+)|.)/g

export const postProcessMultilineStringValue = (
  errors: Error[],
  value: string,
  token: Token,
): string => {
  if (!reUnescapedNewline.test(value)) {
    errors.push(
      new InvalidKdlError('Strings with three quotes must be multiline strings', { token }),
    )
    return value
  }

  if (!reNewline.test(value[0]!)) {
    errors.push(
      new InvalidKdlError('Multi-line strings must start with a newline', { token }),
    )
    return value
  }

  const lastLine = reFinalWhitespaceLineIncludingEscapes.exec(value)?.[1]

  if (lastLine == null) {
    const match = reLastNonWhitespaceOrNewline.exec(value)
    const start = match ? computeStartLocation(token, value, match.index) : undefined

    let message = 'The final line in a multiline string may only contain whitespace'
    if (match?.[0]![0] === '\\') {
      message += ' after removing escaped whitespace'
    }

    errors.push(
      new InvalidKdlError(message, {
        token,
        start,
        end: start
          ? {
              offset: start.offset,
              line: start.line,
              column: start.column + 1,
            }
          : undefined,
      }),
    )

    return value
  }

  return value
    .replace(
      reMultiLineNewLineWithWhitespaceOrEscape,
      (
        match: string,
        newline: string | undefined,
        leadingWhitespace: string | undefined,
        unicode: string | undefined,
        invalidUnicode: string | undefined,
        whitespace: string | undefined,
        offset: number,
      ) => {
        if (!newline) {
          return replaceEscape(errors, value, token, match, unicode, invalidUnicode, whitespace, offset)
        }

        const firstContentCharacter =
          value[offset + newline.length + (leadingWhitespace ? leadingWhitespace.length : 0)]
        if (firstContentCharacter && reNewline.test(firstContentCharacter)) {
          return '\n'
        }

        if (!leadingWhitespace!.startsWith(lastLine)) {
          const start = computeStartLocation(token, value, offset + newline.length)

          errors.push(
            new InvalidKdlError(
              'Every non-blank line of a multi-line string must start with the offset defined by the last line of the string',
              {
                token,
                start,
                end: {
                  offset: start.offset + lastLine.length,
                  line: start.line,
                  column: start.column + lastLine.length,
                },
              },
            ),
          )

          return '\n'
        }

        return '\n' + leadingWhitespace!.slice(lastLine.length)
      },
    )
    .slice(1, -1)
}
