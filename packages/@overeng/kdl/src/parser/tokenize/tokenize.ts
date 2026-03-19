import { InvalidKdlError } from '../internal-error.ts'
import type { Token, TokenType } from '../token.ts'
import {
  consume,
  consumeCodePoint,
  consumeNewline,
  createContext,
  init,
  mkError,
  mkToken,
  pop,
  pushError,
  zeroOrMore,
  zeroOrMoreCodePoint,
  type CreateContextOptions,
  type TokenizeContext,
} from './context.ts'
import {
  isAlpha,
  isBinaryDigit,
  isBinaryDigitOrUnderscore,
  isDecimalDigit,
  isDecimalDigitOrUnderscore,
  isHexadecimalDigit,
  isHexadecimalDigitOrUnderscore,
  isIdentifierChar,
  isNewLine,
  isNumberSign,
  isOctalDigit,
  isOctalDigitOrUnderscore,
  isUnicodeSpace,
} from './types.ts'

const createSingleCharacterToken =
  (type: TokenType) =>
  (ctx: TokenizeContext): Token => {
    pop(ctx)
    return mkToken(ctx, type)
  }

const handleWhitespaceCharacter = (ctx: TokenizeContext): Token => {
  zeroOrMore(ctx, isUnicodeSpace)
  return mkToken(ctx, 'inline-whitespace')
}

const handleNewlineCharacter = (ctx: TokenizeContext): Token => {
  consumeNewline(ctx)
  return mkToken(ctx, 'newline')
}

const handleQuoteCharacter = (ctx: TokenizeContext): Token => {
  pop(ctx)

  let finished = false
  let multiline = false
  if (consumeCodePoint(ctx, 0x22)) {
    if (!consumeCodePoint(ctx, 0x22)) {
      return mkToken(ctx, 'quoted-string')
    }

    multiline = true

    if (ctx.current === 0x22) {
      throw mkError(ctx, 'Multiline strings must start with exactly three quotes')
    }

    while (!finished && ctx.offset < ctx.length) {
      if (consumeCodePoint(ctx, 0x22)) {
        if (consumeCodePoint(ctx, 0x22) && consumeCodePoint(ctx, 0x22)) {
          finished = true
        }
      } else {
        consumeCodePoint(ctx, 0x5c)
        consumeNewline(ctx) || pop(ctx)
      }
    }
  } else {
    while (!finished && ctx.offset < ctx.length) {
      if (consumeCodePoint(ctx, 0x22)) {
        finished = true
      } else {
        consumeCodePoint(ctx, 0x5c)
        consumeNewline(ctx) || pop(ctx)
      }
    }
  }

  if (!finished) {
    throw mkError(ctx, 'Unexpected EOF inside string')
  }

  return mkToken(ctx, multiline ? 'multiline-quoted-string' : 'quoted-string')
}

const handleHashCharacter = (ctx: TokenizeContext): Token => {
  pop(ctx)

  if (ctx.current === 0x23 || ctx.current === 0x22) {
    let numberOfOpeningHashes = 1

    while (consumeCodePoint(ctx, 0x23)) {
      numberOfOpeningHashes++
    }

    if (!consumeCodePoint(ctx, 0x22)) {
      throw mkError(ctx, `Expected a quote after ${'#'.repeat(numberOfOpeningHashes)}`)
    }

    let multiline = false
    if (consumeCodePoint(ctx, 0x22)) {
      if (consumeCodePoint(ctx, 0x22)) {
        if (ctx.current === 0x22) {
          throw mkError(ctx, 'Multiline strings must start with exactly three quotes')
        }

        multiline = true
      } else {
        let numberOfClosingHashes = 0

        while (consumeCodePoint(ctx, 0x23)) {
          numberOfClosingHashes++
        }

        if (numberOfClosingHashes === numberOfOpeningHashes) {
          return mkToken(ctx, 'raw-string')
        }
      }
    }

    while (true) {
      if (ctx.offset >= ctx.length) {
        throw mkError(ctx, 'Unexpected EOF while parsing raw string')
      }

      if (consumeCodePoint(ctx, 0x22)) {
        if (multiline) {
          if (!consumeCodePoint(ctx, 0x22) || !consumeCodePoint(ctx, 0x22)) {
            continue
          }
        }

        let numberOfClosingHashes = 0
        while (numberOfClosingHashes < numberOfOpeningHashes && consumeCodePoint(ctx, 0x23)) {
          numberOfClosingHashes++
        }

        if (numberOfClosingHashes === numberOfOpeningHashes) {
          return mkToken(ctx, multiline ? 'multiline-raw-string' : 'raw-string')
        }
      } else {
        consumeNewline(ctx) || pop(ctx)
      }
    }
  } else {
    let token: Token
    if (ctx.current < 0xff) {
      const handler = characterHandlers[ctx.current]!
      token = handler(ctx)
    } else {
      if (isUnicodeSpace(ctx.current)) {
        token = handleWhitespaceCharacter(ctx)
      } else if (isNewLine(ctx.current)) {
        token = handleNewlineCharacter(ctx)
      } else {
        token = handleIdentifierCharacter(ctx)
      }
    }

    if (token.type !== 'identifier-string') {
      const mutableToken = token as { errors: Array<InvalidKdlError> | undefined }
      ;(mutableToken.errors ??= []).push(
        new InvalidKdlError('Expected a valid identifier', { token }),
      )
    }

    ;(token as { type: TokenType }).type = 'keyword-or-hashed-ident'
    return token
  }
}

const handleDotCharacter = (ctx: TokenizeContext): Token => {
  pop(ctx)

  if (consume(ctx, isDecimalDigit)) {
    zeroOrMore(ctx, isIdentifierChar)
    return mkToken(
      ctx,
      'identifier-string',
      'Invalid identifier, identifiers that start with a sign and a dot must be quoted if the next character is a digit to prevent confusion with decimal numbers',
    )
  }

  zeroOrMore(ctx, isIdentifierChar)
  return mkToken(ctx, 'identifier-string')
}

const handleSlashCharacter = (ctx: TokenizeContext): Token => {
  pop(ctx)

  if (consumeCodePoint(ctx, 0x2d)) {
    return mkToken(ctx, 'slashdash')
  } else if (consumeCodePoint(ctx, 0x2f)) {
    while (ctx.offset < ctx.length && !isNewLine(ctx.current)) {
      pop(ctx)
    }
    return mkToken(ctx, 'comment-single')
  } else if (consumeCodePoint(ctx, 0x2a)) {
    let level = 1

    while (ctx.offset < ctx.length) {
      if (consumeCodePoint(ctx, 0x2a)) {
        if (consumeCodePoint(ctx, 0x2f)) {
          level--
          if (level === 0) {
            return mkToken(ctx, 'comment-multi')
          }
        }
      } else if (consumeCodePoint(ctx, 0x2f)) {
        if (consumeCodePoint(ctx, 0x2a)) {
          level++
        }
      } else {
        consumeNewline(ctx) || pop(ctx)
      }
    }

    throw mkError(ctx, 'Unexpected EOF in multiline comment')
  } else {
    return handleInvalidCharacter(ctx)
  }
}

const handleSignCharacter = (ctx: TokenizeContext): Token => {
  pop(ctx)
  return handleSignCharacterAfterPop(ctx)
}

const handleSignCharacterAfterPop = (ctx: TokenizeContext): Token => {
  if (isDecimalDigit(ctx.current)) {
    return handleNumberCharacter(ctx)
  } else if (consumeCodePoint(ctx, 0x2e)) {
    if (consume(ctx, isDecimalDigit)) {
      zeroOrMore(ctx, isIdentifierChar)
      return mkToken(
        ctx,
        'identifier-string',
        'Invalid identifier or number, surround with quotes to make it an identifier or add a zero between the sign and the decimal point',
      )
    }

    zeroOrMore(ctx, isIdentifierChar)
    return mkToken(ctx, 'identifier-string')
  } else {
    zeroOrMore(ctx, isIdentifierChar)
    return mkToken(ctx, 'identifier-string')
  }
}

const createBaseNumberHandler =
  (
    type: string,
    tokenType: TokenType,
    isDigit: (codePoint: number) => boolean,
    isDigitOrUnderscore: (codePoint: number) => boolean,
  ) =>
  (ctx: TokenizeContext): Token => {
    const prefixCodePoint = pop(ctx)

    if (consume(ctx, isDigit)) {
      zeroOrMore(ctx, isDigitOrUnderscore)
      return mkToken(ctx, tokenType)
    } else if (consumeCodePoint(ctx, 0x5f)) {
      zeroOrMore(ctx, isDigitOrUnderscore)

      if (!isIdentifierChar(ctx.current)) {
        return mkToken(
          ctx,
          tokenType,
          `Invalid ${type} number, the first character after 0${String.fromCodePoint(prefixCodePoint)} cannot be an underscore`,
        )
      }
    }

    zeroOrMore(ctx, isIdentifierChar)
    return mkToken(ctx, 'identifier-string', `Invalid ${type} number`)
  }

const baseNumberHandlers: Array<((ctx: TokenizeContext) => Token) | undefined> =
  Array(256).fill(undefined)
baseNumberHandlers[0x62 /* b */] = createBaseNumberHandler(
  'binary',
  'number-binary',
  isBinaryDigit,
  isBinaryDigitOrUnderscore,
)
baseNumberHandlers[0x6f /* o */] = createBaseNumberHandler(
  'octal',
  'number-octal',
  isOctalDigit,
  isOctalDigitOrUnderscore,
)
baseNumberHandlers[0x78 /* x */] = createBaseNumberHandler(
  'hexadecimal',
  'number-hexadecimal',
  isHexadecimalDigit,
  isHexadecimalDigitOrUnderscore,
)

const handleNumberCharacter = (ctx: TokenizeContext): Token => {
  if (consumeCodePoint(ctx, 0x30)) {
    const baseNumberHandler = baseNumberHandlers[ctx.current]
    if (baseNumberHandler) {
      return baseNumberHandler(ctx)
    }
  }

  zeroOrMore(ctx, isDecimalDigitOrUnderscore)

  if (consumeCodePoint(ctx, 0x2e)) {
    if (!consume(ctx, isDecimalDigit)) {
      if (ctx.current === 0x5f) {
        pushError(
          ctx,
          "Invalid decimal number, the part after the decimal point mustn't start on an underscore",
        )
      } else {
        pushError(ctx, 'Invalid decimal number, a decimal point must be followed by a digit')
      }
    }

    zeroOrMore(ctx, isDecimalDigitOrUnderscore)
  }

  if (consumeCodePoint(ctx, 0x65) || consumeCodePoint(ctx, 0x45)) {
    consume(ctx, isNumberSign)

    if (consume(ctx, isDecimalDigit)) {
      zeroOrMore(ctx, isDecimalDigitOrUnderscore)

      if (isIdentifierChar(ctx.current)) {
        zeroOrMore(ctx, isIdentifierChar)
        return mkToken(
          ctx,
          'identifier-string',
          'Invalid number with suffix, a number with an exponent cannot have a suffix',
        )
      }

      return mkToken(ctx, 'number-decimal')
    } else {
      if (ctx.current === 0x5f) {
        zeroOrMore(ctx, isDecimalDigitOrUnderscore)

        return mkToken(
          ctx,
          'number-decimal',
          "Invalid decimal number, the number after the exponent mustn't start on an underscore",
        )
      } else {
        zeroOrMore(ctx, isIdentifierChar)

        return mkToken(
          ctx,
          'number-decimal',
          'Invalid decimal number, missing a number after the exponent',
        )
      }
    }
  } else {
    return mkToken(ctx, 'number-decimal')
  }
}

const handleR = (ctx: TokenizeContext): Token => {
  pop(ctx)

  if (ctx.current !== 0x23 /* # */) {
    zeroOrMore(ctx, isIdentifierChar)
    return mkToken(ctx, 'identifier-string')
  }

  const token = handleHashCharacter(ctx)
  ;(token.start as { offset: number }).offset--
  ;(token.start as { column: number }).column--

  let message: string
  switch (token.type) {
    case 'raw-string':
    case 'multiline-raw-string':
      message = 'Invalid raw string, the correct syntax is #" "#, not r#" "#'
      break
    default:
      message = 'Invalid token, did you forget a whitespace after this r?'
  }

  const mutableToken = token as { errors: Array<InvalidKdlError> | undefined }
  ;(mutableToken.errors ??= []).push(new InvalidKdlError(message, { token }))
  return token
}

const handleIdentifierCharacter = (ctx: TokenizeContext): Token => {
  pop(ctx)
  zeroOrMore(ctx, isIdentifierChar)
  return mkToken(ctx, 'identifier-string')
}

const handleInvalidCharacter = (ctx: TokenizeContext): never => {
  throw mkError(
    ctx,
    `Unexpected character ${JSON.stringify(String.fromCodePoint(ctx.current))}, did you forget to quote an identifier?`,
  )
}

const characterHandlers: Array<(ctx: TokenizeContext) => Token> = Array(0xff)
characterHandlers.fill(handleIdentifierCharacter)

for (let i = 0; i < 0x20; i++) {
  characterHandlers[i] = handleInvalidCharacter
}

characterHandlers[0x09] = handleWhitespaceCharacter // Character Tabulation
characterHandlers[0x0a] = handleNewlineCharacter // Line Feed
characterHandlers[0x0b] = handleNewlineCharacter // Line Tabulation
characterHandlers[0x0c] = handleNewlineCharacter // Form Feed
characterHandlers[0x0d] = handleNewlineCharacter // Carriage Return
characterHandlers[0x20] = handleWhitespaceCharacter // Space
characterHandlers[0x22] = handleQuoteCharacter // "
characterHandlers[0x23] = handleHashCharacter // #
characterHandlers[0x28] = createSingleCharacterToken('open-paren') // (
characterHandlers[0x29] = createSingleCharacterToken('close-paren') // )
characterHandlers[0x2b] = handleSignCharacter // +
characterHandlers[0x2d] = handleSignCharacter // -
characterHandlers[0x2e] = handleDotCharacter // .
characterHandlers[0x2f] = handleSlashCharacter // /
characterHandlers[0x30] = handleNumberCharacter // 0
characterHandlers[0x31] = handleNumberCharacter // 1
characterHandlers[0x32] = handleNumberCharacter // 2
characterHandlers[0x33] = handleNumberCharacter // 3
characterHandlers[0x34] = handleNumberCharacter // 4
characterHandlers[0x35] = handleNumberCharacter // 5
characterHandlers[0x36] = handleNumberCharacter // 6
characterHandlers[0x37] = handleNumberCharacter // 7
characterHandlers[0x38] = handleNumberCharacter // 8
characterHandlers[0x39] = handleNumberCharacter // 9
characterHandlers[0x3b] = createSingleCharacterToken('semicolon') // ;
characterHandlers[0x3d] = createSingleCharacterToken('equals') // =
characterHandlers[0x5b] = handleInvalidCharacter // [
characterHandlers[0x5c] = createSingleCharacterToken('escline') // \
characterHandlers[0x5d] = handleInvalidCharacter // ]
characterHandlers[0x72] = handleR // r
characterHandlers[0x7b] = createSingleCharacterToken('open-brace') // {
characterHandlers[0x7d] = createSingleCharacterToken('close-brace') // }
characterHandlers[0x85] = handleNewlineCharacter // Next Line
characterHandlers[0xa0] = handleWhitespaceCharacter // No-Break Space

export interface TokenizeOptions extends CreateContextOptions {}

export function* tokenize(text: string, options: TokenizeOptions = {}): Generator<Token, void> {
  const ctx = createContext(text, options)
  yield* init(ctx)

  while (!ctx.currentIter.done) {
    if (ctx.current < 0xff) {
      const handler = characterHandlers[ctx.current]!
      yield handler(ctx)
      continue
    }

    if (isUnicodeSpace(ctx.current)) {
      yield handleWhitespaceCharacter(ctx)
      continue
    }

    if (isNewLine(ctx.current)) {
      yield handleNewlineCharacter(ctx)
      continue
    }

    yield handleIdentifierCharacter(ctx)
  }

  yield mkToken(ctx, 'eof')
}
