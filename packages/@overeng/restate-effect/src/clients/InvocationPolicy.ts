import * as clients from '@restatedev/restate-sdk-clients'
import { Option, type Schema } from 'effect'

import { readIdempotencyKey } from '../schema/Annotations.ts'
import { type RedactionCipher } from '../schema/Redaction.ts'
import {
  effectSerde,
  ingressSerde,
  internalSerde,
  type RestateSerde,
  type SerdeSlot,
} from '../schema/Serde.ts'

/**
 * The contract-invocation policy — the SINGLE place that derives, from a
 * contract handler's schemas + the redaction cipher, every annotation-driven
 * transport fact (decision 0020):
 *
 * - the input / output serdes with the `RedactionCipher` threaded (so a
 *   `Restate.sensitive` field is encrypted on the wire and the journal);
 * - the `Restate.idempotencyKey`-field extraction → the call/send idempotency key;
 * - the SDK `clients.Opts` / `clients.SendOpts` / in-handler `genericCall` /
 *   endpoint-handler opts bags built from the above.
 *
 * BEFORE this module these facts were assembled SEPARATELY in every transport
 * adapter (ingress `call`/`objectCall`/`objectSend`/`workflow*`, the in-handler
 * `genericCall`/`genericSend`, the endpoint `handlerOpts`, and the harness),
 * so support was partial by construction — `Client.call` missed BOTH the
 * redaction cipher AND Service idempotency. Every adapter now consumes this one
 * boundary, so an annotation behaves identically at every public entrypoint and
 * adding a new annotation is a one-file change.
 */

/**
 * The per-handler serde pair, with the redaction cipher already threaded. The
 * `slot` decides decode-failure classification (docs/vrs/02-schema-serde/spec.md §1):
 * a caller-facing boundary (ingress, in-handler peer call) is `ingress` (a
 * malformed payload is a deterministic `TerminalError(400)`); an internal
 * journal value is `internal` (a decode failure is a corrupt-journal defect).
 */
export interface ContractSerdes {
  readonly input: RestateSerde<unknown>
  readonly output: RestateSerde<unknown>
}

/**
 * Build the serde factory bound to one redaction cipher (resolved ONCE from the
 * runtime/ingress context). `forSchema` derives a single redaction-threaded
 * serde for a value schema; `forHandler` derives the input/output pair for a
 * handler spec. Every adapter takes its serdes from here, so the redaction
 * cipher is threaded in ONE place rather than at each `ingressSerde` call site.
 */
export const contractSerdeFactory = (redaction: RedactionCipher | undefined) => {
  const serdeOpts = redaction !== undefined ? { redaction } : undefined
  /** A single redaction-threaded serde for a value schema, at the given slot. */
  const forSchema = (
    schema: Schema.Schema<unknown, unknown>,
    slot: SerdeSlot,
  ): RestateSerde<unknown> => effectSerde(schema, slot, serdeOpts)
  return {
    redaction,
    forSchema,
    /** The redaction-threaded input/output serde pair for a handler spec. */
    forHandler: (
      spec: {
        readonly input: Schema.Schema<unknown, unknown>
        readonly success: Schema.Schema<unknown, unknown>
      },
      slot: SerdeSlot,
    ): ContractSerdes => ({
      input: forSchema(spec.input, slot),
      output: forSchema(spec.success, slot),
    }),
  } as const
}

export type ContractSerdeFactory = ReturnType<typeof contractSerdeFactory>

/**
 * The idempotency key for one invocation: the value of the input's
 * `Restate.idempotencyKey`-annotated field (decision 0011 — the SINGLE source),
 * or `undefined` when no field is annotated / the value is absent/non-string.
 * Derived in ONE place so Service `call`, Object `call`/`send`, Workflow submit,
 * and the in-handler peer call all extract the key identically.
 */
export const invocationIdempotencyKey = (
  inputSchema: Schema.Schema<unknown, unknown>,
  input: unknown,
): string | undefined => readIdempotencyKey(inputSchema.ast, input).pipe(Option.getOrUndefined)

/**
 * The complete ingress-call opts: the redaction-threaded input/output serdes AND
 * the idempotency key folded into one `clients.Opts` — the single bag the SDK
 * ingress `call` takes. Used by Service `call`, Object `objectCall`, and Workflow
 * `workflowCall`, so all three carry redaction + idempotency by construction.
 */
export const ingressCallOpts = (params: {
  readonly serdes: ContractSerdeFactory
  readonly inputSchema: Schema.Schema<unknown, unknown>
  readonly outputSchema: Schema.Schema<unknown, unknown>
  readonly input: unknown
}): clients.Opts<unknown, unknown> => {
  const idempotencyKey = invocationIdempotencyKey(params.inputSchema, params.input)
  return clients.Opts.from({
    input: params.serdes.forSchema(params.inputSchema, 'ingress'),
    output: params.serdes.forSchema(params.outputSchema, 'ingress'),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  })
}

/**
 * The complete ingress-send opts: the redaction-threaded INPUT serde, the
 * idempotency key, and an optional `delay`, folded into one `clients.SendOpts`
 * (a one-way send has no output). Used by Object `objectSend` and Workflow
 * `workflowSubmit`.
 */
export const ingressSendOpts = (params: {
  readonly serdes: ContractSerdeFactory
  readonly inputSchema: Schema.Schema<unknown, unknown>
  readonly input: unknown
  readonly delayMillis?: number
}): clients.SendOpts<unknown> => {
  const idempotencyKey = invocationIdempotencyKey(params.inputSchema, params.input)
  return clients.SendOpts.from({
    input: params.serdes.forSchema(params.inputSchema, 'ingress'),
    ...(params.delayMillis !== undefined ? { delay: params.delayMillis } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  })
}

/**
 * Convenience re-exports so a caller that only needs an output serde (workflow
 * attach / output / ingress `result` — no input on the wire) still derives it
 * through the policy. Redaction is threaded via {@link contractSerdeFactory}; an
 * output-only attach uses the `ingress` slot (a caller-facing decode boundary).
 */
export { ingressSerde, internalSerde }
