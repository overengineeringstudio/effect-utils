import { createGenieOutput } from '../core.ts'
import type { GenieOutput, Strict } from '../mod.ts'

/** Arguments for generating a JSON artifact from plain typed data. */
export type JsonArtifactDataArgs<TData> = {
  /** Typed source-of-truth data kept available to TS consumers via `.data`. */
  data: TData
  /** JSON indentation level. Defaults to 2. */
  indentation?: number
}

/** Arguments for generating a JSON artifact through custom encoding. */
export type JsonArtifactEncodedArgs<TData> = {
  /** Typed source-of-truth data kept available to TS consumers via `.data`. */
  data: TData
  /** Optional encoder for callers that want a stricter serialized representation. */
  encode: (data: TData) => unknown
  /** JSON indentation level. Defaults to 2. */
  indentation?: number
}

/**
 * Creates a JSON artifact from typed data.
 *
 * If an encoder is provided, the emitted file content is derived through it.
 * Otherwise the data is stringified as-is.
 */
export function jsonArtifact<const TData>(
  args: Strict<JsonArtifactDataArgs<TData>, JsonArtifactDataArgs<TData>>,
): GenieOutput<TData>
export function jsonArtifact<const TData>(
  args: Strict<JsonArtifactEncodedArgs<TData>, JsonArtifactEncodedArgs<TData>>,
): GenieOutput<TData>
export function jsonArtifact<const TData>(
  args:
    | Strict<JsonArtifactDataArgs<TData>, JsonArtifactDataArgs<TData>>
    | Strict<JsonArtifactEncodedArgs<TData>, JsonArtifactEncodedArgs<TData>>,
): GenieOutput<TData> {
  return createGenieOutput({
    data: args.data,
    stringify: (_ctx) => {
      const jsonValue = 'encode' in args ? args.encode(args.data) : args.data

      return JSON.stringify(jsonValue, null, args.indentation ?? 2) + '\n'
    },
  })
}
