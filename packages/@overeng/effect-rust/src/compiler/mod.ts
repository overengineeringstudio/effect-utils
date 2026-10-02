/**
 * Contract compiler between Effect Schema and Rust.
 *
 * Effect-owned direction: {@link compile} (or {@link contractsOf} + {@link compile} for a whole module namespace)
 * lowers live Effect schemas to the contract IR and emits a standalone Rust crate, versioned JSON Schema, Effect
 * Schema source, optional Borsh frame codecs and shared vector tests. It is pure and deterministic; the caller
 * (Buck rule, packager, script) owns the filesystem.
 *
 * Rust-owned direction: {@link importRustSchema} admits one schemars 1.x Draft 2020-12 document (`$defs` holding every
 * reachable contract type, root `$ref`) and returns the IR plus Effect Schema source exporting one strict codec per
 * definition. Admission is strict: an unsupported keyword, lossy number, open object or non-portable pattern
 * rejects with an {@link AdmissionError} carrying a JSON-Pointer path and a remedy; nothing is silently dropped.
 *
 * Vocabulary `https://effect-rust.dev/schema/v1` ({@link EFFECT_RUST_VOCABULARY}); the complete keyword list is
 * {@link EFFECT_RUST_KEYWORDS}:
 * - `x-effect-rust-width`: `u8` | `u16` | `u32` | `i8` | `i16` | `i32` | `u64` | `i64` on `type: integer`;
 *   authored minimum/maximum stay independent of storage. Numeric 64-bit storage requires explicit safe-integer bounds.
 *   `u64` | `i64` on `type: string` together with the matching `x-effect-rust-format`.
 * - `x-effect-rust-format`: `u64-decimal` | `i64-decimal` (canonical base-10 string; `pattern` may only repeat the
 *   canonical decimal pattern) or `date-time-millis` (`format: date-time`, RFC 3339 with offset, millisecond precision).
 *   Decimal subranges use canonical string `x-effect-rust-minimum`/`x-effect-rust-maximum`.
 * - `x-effect-rust-pattern` + `x-effect-rust-pattern-flags` (`u` default | `iu`): portable full-string regex on a named
 *   string definition; `pattern` may be present but must be identical. Optional `minLength`/`maxLength` count code points.
 * - `x-effect-rust-excess`: `error` (default) | `ignore` on struct objects. Structs always carry
 *   `additionalProperties: false`, including `ignore` (the policy lives in this keyword, not in an open object).
 * - `x-effect-rust-non-exhaustive`: boolean on a struct object or tagged-union `oneOf`/`anyOf`.
 * - `x-effect-rust-patch`: `true` on an object property schema `anyOf: [{ type: null }, T]` (never in `required`):
 *   absent, `null` and value stay distinct.
 *
 * Tagged unions are `oneOf`/`anyOf` of closed objects sharing one required `const` string discriminator (serde
 * internally tagged, any tag key). Records are objects with typed `additionalProperties` (optional `propertyNames`)
 * and no `properties`. Wire JSON decoders accept any key order; canonical encoders emit the discriminator first, then
 * the remaining keys sorted by UTF-16 code unit.
 */
import { Schema } from 'effect'

import type { FrameOptions } from '../schema/borsh.ts'
import { canonicalJson } from '../schema/json.ts'
import { importRustSchema } from './import-rust.ts'
import { tagFields, type ContractIR } from './ir.ts'
import { emitJsonSchema } from './json-schema.ts'
import { lower } from './lower.ts'
import { emitRust, type RustOptions } from './rust.ts'
export { lower } from './lower.ts'
export { emitJsonSchema, EFFECT_RUST_KEYWORDS, EFFECT_RUST_VOCABULARY } from './json-schema.ts'
export { importRustSchema } from './import-rust.ts'
export { emitRust } from './rust.ts'
export type {
  CargoInheritedMetadata,
  CargoOptions,
  RustOptions,
  RustVector,
  RustOutput,
} from './rust.ts'
export { AdmissionError, tagFields } from './ir.ts'
export type { ContractIR, Definition, Field, Type, Width } from './ir.ts'

/** Shared acceptance vector: `input`/`canonical` are JSON data; decoders see `JSON.stringify(input)`. */
export interface Vector {
  readonly contract: string
  readonly name: string
  readonly input: unknown
  readonly accept: boolean
  readonly canonical?: unknown
}
/** Rust crate options plus optional framed contract outputs. */
export interface CompileOptions extends RustOptions {
  readonly frames?: Readonly<Record<string, FrameOptions>>
}
/**
 * `files` maps package-relative paths to contents: `Cargo.toml`, `src/lib.rs`, and per contract `schema/<Name>.json`,
 * `effect/<Name>.ts`, optional `effect/<Name>.frame.ts`, plus `effect/vectors.unit.test.ts` when vectors are given.
 */
export interface CompileOutput {
  readonly ir: ContractIR
  readonly files: Readonly<Record<string, string>>
}

/** Selects the schema-valued exports of a contract module namespace (`import * as Contracts from './contracts.ts'`). */
export const contractsOf = (
  module: Readonly<Record<string, unknown>>,
): Readonly<Record<string, Schema.Constraint>> =>
  Object.fromEntries(
    Object.entries(module).filter((entry): entry is [string, Schema.Constraint] =>
      Schema.isSchema(entry[1]),
    ),
  )

/** Pure deterministic compiler; filesystem/build orchestration belongs to the caller. Throws {@link AdmissionError}. */
// eslint-disable-next-line overeng/named-args -- Preserve the public compile positional SDK signature.
export const compile = (
  contracts: Readonly<Record<string, Schema.Constraint>>,
  options: CompileOptions = {},
): CompileOutput => {
  const ir = lower(contracts, options.crateName ?? 'contracts')
  const rust = emitRust(ir, options)
  const files: Record<string, string> = { 'Cargo.toml': rust.cargoToml, 'src/lib.rs': rust.source }
  // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
  for (const name of Object.keys(contracts).sort()) {
    const document = emitJsonSchema(ir, name)
    files[`schema/${name}.json`] = JSON.stringify(document, null, 2) + '\n'
    files[`effect/${name}.ts`] = importRustSchema(document, name).source
    const frame = options.frames?.[name]
    if (frame !== undefined)
      files[`effect/${name}.frame.ts`] =
        `import { Borsh } from '@overeng/effect-rust'\nimport { ${name} } from './${name}.ts'\nexport const codec = Borsh.frame(${name}, ${JSON.stringify(frame)})\n`
  }
  if (options.vectors !== undefined)
    files['effect/vectors.unit.test.ts'] = emitVitest(ir, options.vectors)
  return { ir, files }
}
/** Each shared vector is a named consumer-visible test: strict JSON text decode, then byte-exact canonical encode. */
// eslint-disable-next-line overeng/named-args -- Preserve the public emitVitest positional SDK signature.
export const emitVitest = (ir: ContractIR, vectors: readonly Vector[]): string => {
  const tags = tagFields(ir)
  const imports = [...new Set(vectors.map((vector) => vector.contract))]
    // eslint-disable-next-line unicorn/no-array-sort -- This array is freshly constructed here; sorting in place avoids an unnecessary copy.
    .sort()
    .map((name) => `import { ${name} } from './${name}.ts'`)
    .join('\n')
  const tests = vectors
    .map((vector) => {
      const text = JSON.stringify(JSON.stringify(vector.input))
      const body =
        vector.accept === true
          ? `const value = ContractJson.decode(${vector.contract})(${text})\n  expect(ContractJson.encode(${vector.contract})(value)).toBe(${JSON.stringify(canonicalJson(vector.canonical ?? vector.input, tags))})`
          : `expect(() => ContractJson.decode(${vector.contract})(${text})).toThrow()`
      return `it(${JSON.stringify(`${vector.contract}/${vector.name}`)}, () => {\n  ${body}\n})`
    })
    .join('\n')
  return `import { it } from '@effect/vitest'\nimport { expect } from 'vitest'\nimport { ContractJson } from '@overeng/effect-rust'\n${imports}\n${tests}\n`
}
