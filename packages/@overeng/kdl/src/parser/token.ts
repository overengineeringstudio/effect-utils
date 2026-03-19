import type { InvalidKdlError } from './internal-error.ts'

export type TokenType =
  | 'eof'
  | 'bom'
  | 'slashdash'
  | 'open-paren'
  | 'close-paren'
  | 'open-brace'
  | 'close-brace'
  | 'semicolon'
  | 'quoted-string'
  | 'raw-string'
  | 'identifier-string'
  | 'equals'
  | 'keyword-or-hashed-ident'
  | 'number-hexadecimal'
  | 'number-decimal'
  | 'number-octal'
  | 'number-binary'
  | 'inline-whitespace'
  | 'newline'
  | 'escline'
  | 'comment-single'
  | 'comment-multi'
  | 'multiline-quoted-string'
  | 'multiline-raw-string'

export interface Location {
  readonly offset: number
  readonly line: number
  readonly column: number
}

export interface Token {
  readonly type: TokenType
  readonly text: string
  readonly start: Location
  readonly end: Location
  readonly errors: Array<InvalidKdlError> | undefined
}
