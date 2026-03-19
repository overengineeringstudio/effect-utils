/**
 * @module @overeng/kdl
 *
 * Native TypeScript implementation of KDL v2 (https://kdl.dev/).
 * Format-preserving parser and serializer with Effect integration.
 */

export { Document } from './model/document.ts'
export { Node } from './model/node.ts'
export { Entry } from './model/entry.ts'
export { Value, type Primitive } from './model/value.ts'
export { Identifier } from './model/identifier.ts'
export { Tag } from './model/tag.ts'
export { KdlParseError, type KdlLocation } from './error.ts'
export { InvalidKdlError } from './parser/internal-error.ts'
export { parse, parseEffect, type ParseOptions } from './parse.ts'
export { format } from './format.ts'
export { clearFormat } from './clear-format.ts'
