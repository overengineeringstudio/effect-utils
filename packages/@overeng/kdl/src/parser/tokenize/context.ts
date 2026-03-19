import { InvalidKdlError } from '../internal-error.ts'
import type { Location, Token, TokenType } from '../token.ts'
import { isInvalidCharacter, isNewLine } from './types.ts'

let segmenter: Intl.Segmenter | undefined

function* iterateGraphemes(text: string): Generator<string, void, undefined> {
  for (const segment of (segmenter ??= new Intl.Segmenter('en')).segment(text)) {
    yield segment.segment
  }
}

const iterateCodePoints = (text: string): Iterator<string> =>
  text[Symbol.iterator]()

export interface TokenizeContext {
  readonly text: string
  line: number
  column: number
  offset: number
  readonly length: number
  readonly iterator: Iterator<string, void>
  currentIter: IteratorResult<string, void>
  /** First code point of the iterator's last result, or NaN if the iterator has ended */
  current: number
  start: Location
  readonly graphemeLocations: boolean
  errorsInToken: Array<InvalidKdlError> | undefined
}

export interface CreateContextOptions {
  readonly graphemeLocations?: boolean
}

export const createContext = (text: string, options: CreateContextOptions = {}): TokenizeContext => {
  const { graphemeLocations = false } = options
  const iterator = graphemeLocations ? iterateGraphemes(text) : iterateCodePoints(text)
  const currentIter = iterator.next()

  return {
    text,
    graphemeLocations,
    line: 1,
    column: 1,
    offset: 0,
    length: text.length,
    iterator,
    currentIter,
    current: currentIter.done ? NaN : (currentIter.value.codePointAt(0) as number),
    start: { line: 1, column: 1, offset: 0 },
    errorsInToken: undefined,
  }
}

export function* init(ctx: TokenizeContext): Generator<Token, void> {
  if (consumeCodePoint(ctx, 0xfeff)) {
    ctx.column = 1
    yield mkToken(ctx, 'bom')
  }

  if (isInvalidCharacter(ctx.current)) {
    throw mkError(ctx, `Invalid character \\u${ctx.current.toString(16)}`)
  }
}

export const pop = (ctx: TokenizeContext): number => {
  ctx.offset += (ctx.currentIter.value as string).length
  ctx.column++

  const currentIter = (ctx.currentIter = ctx.iterator.next())
  const current = (ctx.current =
    currentIter.done ? NaN : (currentIter.value.codePointAt(0) as number))

  if (isInvalidCharacter(current)) {
    if ((current >= 0xd800 && current <= 0xdfff) || current > 0x10ffff) {
      pushError(ctx, `Invalid character \\u${current.toString(16)}`)
    } else {
      pushError(
        ctx,
        `Invalid character \\u${current.toString(16)}, this character is not allowed but can be included in strings as \\u{${current.toString(16)}}`,
      )
    }
  }

  return current
}

export const consume = (ctx: TokenizeContext, test: (codePoint: number) => boolean): number | undefined => {
  if (test(ctx.current)) {
    const previous = ctx.current
    pop(ctx)
    return previous
  }
  return undefined
}

export const consumeCodePoint = (ctx: TokenizeContext, codePoint: number): number | undefined => {
  if (ctx.current === codePoint) {
    pop(ctx)
    return codePoint
  }
  return undefined
}

export const consumeNewline = (ctx: TokenizeContext): boolean => {
  if (!isNewLine(ctx.current)) {
    return false
  }

  if (
    !ctx.graphemeLocations &&
    ctx.current === 0x0d &&
    ctx.text.codePointAt(ctx.offset + 1) === 0x0a
  ) {
    ctx.iterator.next()
    ctx.offset++
  }

  pop(ctx)

  ctx.column = 1
  ctx.line++

  return true
}

export const zeroOrMoreCodePoint = (ctx: TokenizeContext, codePoint: number): void => {
  while (ctx.current === codePoint) {
    pop(ctx)
  }
}

export const zeroOrMore = (ctx: TokenizeContext, test: (codePoint: number) => boolean): void => {
  while (test(ctx.current)) {
    pop(ctx)
  }
}

export const mkToken = (ctx: TokenizeContext, type: TokenType, error?: string): Token => {
  const { line, column, offset } = ctx
  const end = { line, column, offset }
  const s = ctx.start

  ctx.start = end

  const errors = ctx.errorsInToken
  ctx.errorsInToken = undefined

  const token: Token = {
    type,
    text: ctx.text.slice(s.offset, end.offset),
    start: s,
    end,
    errors,
  }

  if (error) {
    const mutableErrors: Array<InvalidKdlError> = (token as { errors: Array<InvalidKdlError> | undefined }).errors ??= []
    mutableErrors.push(new InvalidKdlError(error, { token }))
  }

  return token
}

export const mkError = (ctx: TokenizeContext, message: string | InvalidKdlError): InvalidKdlError => {
  if (message instanceof InvalidKdlError) {
    return message
  }

  const { line, column, offset } = ctx
  const start = { line, column, offset }
  let end: Location | undefined

  if (offset < ctx.length) {
    if (isNewLine(ctx.current)) {
      end = { line: line + 1, column: 1, offset: offset + 1 }
    } else {
      end = { line, column: column + 1, offset: offset + 1 }
    }
  }

  return new InvalidKdlError(`${message}`, { start, end })
}

export const pushError = (ctx: TokenizeContext, message: string | InvalidKdlError): void => {
  ;(ctx.errorsInToken ??= []).push(mkError(ctx, message))
}
