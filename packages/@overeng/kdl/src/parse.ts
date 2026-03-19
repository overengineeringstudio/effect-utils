import { Effect, Option } from 'effect'

import { KdlParseError } from './error.ts'
import { resolveFlags, type ParserFlags } from './flags.ts'
import type { Document } from './model/document.ts'
import type { Entry } from './model/entry.ts'
import type { Identifier } from './model/identifier.ts'
import type { Node } from './model/node.ts'
import type { Value } from './model/value.ts'
import { InvalidKdlError } from './parser/internal-error.ts'
import {
  parseWhitespaceInDocument,
  parseWhitespaceInNode,
  type WhitespaceInDocument,
  type WhitespaceInNode,
} from './parser/parse-whitespace.ts'
import {
  finalize,
  createParserCtx,
  parseDocument,
  parseIdentifier,
  parseNodePropOrArgWithSpace,
  parseNodeWithSpace,
  parseValue,
} from './parser/parse.ts'
import { tokenize } from './parser/tokenize/mod.ts'

type ParseTarget = keyof typeof methods

type ParseResult<TTarget extends ParseTarget> = TTarget extends 'document'
  ? Document
  : TTarget extends 'node'
    ? Node
    : TTarget extends 'entry'
      ? Entry
      : TTarget extends 'value'
        ? Value
        : TTarget extends 'identifier'
          ? Identifier
          : TTarget extends 'whitespace in document'
            ? WhitespaceInDocument
            : TTarget extends 'whitespace in node'
              ? WhitespaceInNode
              : never

const methods = {
  value: parseValue,
  identifier: parseIdentifier,
  node: parseNodeWithSpace,
  entry: parseNodePropOrArgWithSpace,
  document: parseDocument,
  'whitespace in document': parseWhitespaceInDocument,
  'whitespace in node': parseWhitespaceInNode,
} as const

export interface ParseOptions<TTarget extends ParseTarget = 'document'> {
  as?: TTarget
  storeLocations?: boolean
  graphemeLocations?: boolean
  flags?: Partial<ParserFlags>
}

/** Parse a KDL string into an AST (throws InvalidKdlError on error) */
export const parse = <TTarget extends ParseTarget = 'document'>(
  text:
    | string
    | ArrayBuffer
    | Uint8Array
    | Int8Array
    | Uint16Array
    | Int16Array
    | Uint32Array
    | Int32Array
    | DataView,
  options: ParseOptions<TTarget> = {},
): ParseResult<TTarget> => {
  const { as: target = 'document' as TTarget, flags, ...parserOptions } = options

  const parserMethod = methods[target]
  if (parserMethod == null) {
    throw new TypeError(`Invalid "as" target passed: ${JSON.stringify(target)}`)
  }

  let str: string
  if (typeof text !== 'string') {
    if (typeof TextDecoder !== 'function') {
      throw new TypeError(
        'Uint8Array input is only supported on platforms that include TextDecoder',
      )
    }
    const decoder = new TextDecoder('utf-8', { fatal: true })
    str = decoder.decode(text)
  } else {
    str = text
  }

  const resolvedFlags = resolveFlags(flags)

  const tokens = tokenize(
    str,
    parserOptions.graphemeLocations !== undefined
      ? { graphemeLocations: parserOptions.graphemeLocations }
      : {},
  )

  const ctx = createParserCtx(str, tokens, {
    ...parserOptions,
    flags: resolvedFlags,
  })

  let value: unknown
  try {
    value = parserMethod(ctx)
  } catch (e) {
    finalize(ctx, e)
  }

  finalize(ctx)

  if (!value) {
    throw new InvalidKdlError(`Expected ${/^[aeiouy]/.exec(target) ? 'an' : 'a'} ${target}`)
  }

  return value as ParseResult<TTarget>
}

const toOption = <T>(value: T | undefined): Option.Option<NonNullable<T>> =>
  value != null ? Option.some(value as NonNullable<T>) : Option.none()

/** Parse a KDL string into an AST, returning an Effect that fails with KdlParseError */
export const parseEffect = (
  text: string | ArrayBuffer | Uint8Array,
  options: ParseOptions<'document'> = {},
): Effect.Effect<Document, KdlParseError> =>
  Effect.try({
    try: () => parse(text, options),
    catch: (error) =>
      error instanceof InvalidKdlError
        ? new KdlParseError({
            message: error.message,
            start: toOption(error.start),
            end: toOption(error.end),
            errors: Option.none(),
          })
        : new KdlParseError({
            message: `Unexpected parse error: ${String(error)}`,
            start: Option.none(),
            end: Option.none(),
            errors: Option.none(),
          }),
  })
