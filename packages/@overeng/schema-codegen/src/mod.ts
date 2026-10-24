import { Schema } from 'effect'

/** Shared Effect Schema admission and portable contract IR; emitters own target rendering. */
export { lower } from './lower.ts'
export {
  AdmissionError,
  hasNumericFloats,
  integerRanges,
  reject,
  tagFields,
  type ContractIR,
  type Definition,
  type Field,
  type Type,
  type Width,
} from './ir.ts'
export { assertPortablePattern, pattern } from './pattern.ts'
export { discriminator, tagKeys } from './discriminator.ts'
export { isTimestampAST, validTimestampMillis } from './timestamp.ts'
/** Selects the schema-valued exports of a contract module namespace (`import * as Contracts from './contracts.ts'`). */
export const contractsOf = (
  module: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Schema.Constraint>> =>
  Object.fromEntries(
    Object.entries(module).filter((entry): entry is [string, Schema.Constraint] =>
      Schema.isSchema(entry[1]),
    ),
  )
