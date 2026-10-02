/** Explicit transport Layers, scoped Rust runtimes, and host capability bridges. */
export * as Interop from './runtime/interop.ts'
/** Strict portable wire schemas, canonical JSON, and Borsh frame codecs. */
export * as Wire from './schema/wire.ts'
/** Contract admission and bidirectional Rust/Effect schema compilation. */
export * as Compiler from './compiler/mod.ts'
export { Init, Input, Transport, Unsupported } from './runtime/errors.ts'
