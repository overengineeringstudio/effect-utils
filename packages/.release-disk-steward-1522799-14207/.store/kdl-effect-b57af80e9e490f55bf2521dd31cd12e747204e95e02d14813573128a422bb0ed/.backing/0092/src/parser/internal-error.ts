import type { Location, Token } from './token.ts'

export interface InvalidKdlErrorOptions extends ErrorOptions {
  readonly token?: Token
  readonly start?: Location | undefined
  readonly end?: Location | undefined
  readonly errors?: Array<InvalidKdlError>
}

/** Lightweight error used internally during tokenization/parsing */
export class InvalidKdlError extends Error {
  override readonly name = 'InvalidKdlError'
  readonly start: Location | undefined
  readonly end: Location | undefined
  readonly token: Token | undefined
  readonly errors: Array<InvalidKdlError> | undefined

  constructor(message: string, options: InvalidKdlErrorOptions = {}) {
    const { token, start = token?.start, end = token?.end, errors, ...rest } = options

    if (token?.type === 'eof') {
      message = `${message} at end of input`
    } else if (start) {
      message = `${message} at ${start.line}:${start.column}`
    }

    super(message, rest)

    this.token = token
    this.start = start
    this.end = end
    this.errors = errors
  }

  *flat(): Generator<InvalidKdlError, void, void> {
    if (this.errors == null) {
      yield this
      return
    }

    for (const error of this.errors) {
      yield* error.flat()
    }
  }
}
