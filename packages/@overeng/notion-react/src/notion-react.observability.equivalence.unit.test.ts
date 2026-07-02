/**
 * Property-based encoder-equivalence proof for the `notion-react.*` telemetry migration (SC-R14).
 *
 * The migration re-points both o11y adapters (`o11y/effect-adapter.ts`, `o11y/otel-adapter.ts`) at
 * DERIVED encoders — their `OtelAttrs.defineSync` bundles are REBUILT from the registered seam
 * contract's `notion-react.*` catalog schemas (`./notion-react.contract.ts`). This test proves
 * "no runtime behavior lost": for every migrated bundle, the DERIVED encoder produces byte-identical
 * attribute maps to an INDEPENDENT, hand-authored baseline (inline `OtelAttr.*`, mirroring the
 * pre-migration source, with the original `Schema.NonNegativeInt` / `Schema.Number` / `Schema.String`
 * / `Schema.Literal` field schemas).
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the contract), so the comparison is real and not vacuous. All keys are already namespaced
 * `notion-react.*` (behavior-preserving; no renames). `service.name` (a resource attribute) and
 * `span.label` are runtime-only and stay inline in BOTH baseline and derived.
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'

import {
  NotionReactBatchBatched,
  NotionReactBatchIssued,
  NotionReactBlockId,
  NotionReactCheckpointBytes,
  NotionReactDurationMs,
  NotionReactFallbackReason,
  NotionReactNoopReason,
  NotionReactOk,
  NotionReactOpCount,
  NotionReactOpDurationMs,
  NotionReactOpError,
  NotionReactOpId,
  NotionReactOpKind,
  NotionReactOpNote,
  NotionReactOpResultCount,
  NotionReactPageId,
  NotionReactRootBlockCount,
} from './notion-react.contract.ts'

// ---- runtime-only fields (excluded from the registry; identical on both sides) ----
const serviceName = Schema.NonEmptyString.pipe(OtelAttr.key({ key: 'service.name' }))
const spanLabel = Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const OpKind = Schema.Literal('append', 'update', 'delete', 'retrieve')

// ---- baseline field builders (mirror the pre-migration inline schemas) ----
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))
const nnint = (key: string) => Schema.NonNegativeInt.pipe(OtelAttr.key({ key }))
const num = (key: string) => Schema.Number.pipe(OtelAttr.key({ key }))
const bool = (key: string) => Schema.Boolean.pipe(OtelAttr.key({ key }))

// ---- generation-safe input primitives ----
const Str = Schema.String
const NEStr = Schema.NonEmptyString
const NNInt = Schema.NonNegativeInt
const FiniteNum = Schema.Number.pipe(Schema.filter((n): n is number => Number.isFinite(n)))

const bundle = (fields: Schema.Struct.Fields) =>
  OtelAttrs.defineSync(Schema.Struct(fields) as unknown as Schema.Schema.AnyNoContext)

const cases = [
  {
    name: 'SyncStart',
    baseline: bundle({
      serviceName,
      label: spanLabel,
      pageId: s('notion-react.page_id'),
      rootBlockCount: nnint('notion-react.root_block_count'),
    }),
    derived: bundle({
      serviceName,
      label: spanLabel,
      pageId: NotionReactPageId,
      rootBlockCount: NotionReactRootBlockCount,
    }),
    input: Schema.Struct({ serviceName: NEStr, label: NEStr, pageId: Str, rootBlockCount: NNInt }),
  },
  {
    name: 'SyncEnd',
    baseline: bundle({
      ok: bool('notion-react.ok'),
      opCount: nnint('notion-react.op_count'),
      durationMs: num('notion-react.duration_ms'),
      fallbackReason: Schema.optional(s('notion-react.fallback_reason')),
    }),
    derived: bundle({
      ok: NotionReactOk,
      opCount: NotionReactOpCount,
      durationMs: NotionReactDurationMs,
      fallbackReason: Schema.optional(NotionReactFallbackReason),
    }),
    input: Schema.Struct({
      ok: Schema.Boolean,
      opCount: NNInt,
      durationMs: FiniteNum,
      fallbackReason: Schema.optional(Str),
    }),
  },
  {
    name: 'OpStart',
    baseline: bundle({
      serviceName,
      label: OpKind.pipe(OtelAttr.spanLabel()),
      id: nnint('notion-react.op.id'),
      kind: Schema.Literal('append', 'update', 'delete', 'retrieve').pipe(
        OtelAttr.key({ key: 'notion-react.op.kind' }),
      ),
    }),
    derived: bundle({
      serviceName,
      label: OpKind.pipe(OtelAttr.spanLabel()),
      id: NotionReactOpId,
      kind: NotionReactOpKind,
    }),
    input: Schema.Struct({ serviceName: NEStr, label: OpKind, id: NNInt, kind: OpKind }),
  },
  {
    name: 'OpSucceeded',
    baseline: bundle({
      durationMs: num('notion-react.op.duration_ms'),
      resultCount: nnint('notion-react.op.result_count'),
      note: Schema.optional(
        Schema.Literal('already-archived').pipe(OtelAttr.key({ key: 'notion-react.op.note' })),
      ),
    }),
    derived: bundle({
      durationMs: NotionReactOpDurationMs,
      resultCount: NotionReactOpResultCount,
      note: Schema.optional(NotionReactOpNote),
    }),
    input: Schema.Struct({
      durationMs: FiniteNum,
      resultCount: NNInt,
      note: Schema.optional(Schema.Literal('already-archived')),
    }),
  },
  {
    name: 'OpFailed',
    baseline: bundle({
      durationMs: num('notion-react.op.duration_ms'),
      error: s('notion-react.op.error'),
    }),
    derived: bundle({ durationMs: NotionReactOpDurationMs, error: NotionReactOpError }),
    input: Schema.Struct({ durationMs: FiniteNum, error: Str }),
  },
  {
    name: 'FallbackEvent',
    baseline: bundle({ serviceName, reason: s('notion-react.fallback_reason') }),
    derived: bundle({ serviceName, reason: NotionReactFallbackReason }),
    input: Schema.Struct({ serviceName: NEStr, reason: Str }),
  },
  {
    name: 'BatchFlushEvent',
    baseline: bundle({
      serviceName,
      issued: nnint('notion-react.batch.issued'),
      batched: nnint('notion-react.batch.batched'),
    }),
    derived: bundle({
      serviceName,
      issued: NotionReactBatchIssued,
      batched: NotionReactBatchBatched,
    }),
    input: Schema.Struct({ serviceName: NEStr, issued: NNInt, batched: NNInt }),
  },
  {
    name: 'UpdateNoopEvent',
    baseline: bundle({
      serviceName,
      blockId: s('notion-react.block_id'),
      reason: Schema.Literal('hash-equal', 'other').pipe(
        OtelAttr.key({ key: 'notion-react.noop_reason' }),
      ),
    }),
    derived: bundle({ serviceName, blockId: NotionReactBlockId, reason: NotionReactNoopReason }),
    input: Schema.Struct({
      serviceName: NEStr,
      blockId: Str,
      reason: Schema.Literal('hash-equal', 'other'),
    }),
  },
  {
    name: 'CheckpointWrittenEvent',
    baseline: bundle({
      serviceName,
      bytes: Schema.optional(nnint('notion-react.checkpoint.bytes')),
    }),
    derived: bundle({ serviceName, bytes: Schema.optional(NotionReactCheckpointBytes) }),
    input: Schema.Struct({ serviceName: NEStr, bytes: Schema.optional(NNInt) }),
  },
] as const

describe('notion-react.* derived bundle encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of cases) {
    it.prop(
      `${c.name}: derived .encodeSync ≡ baseline.encodeSync`,
      [c.input],
      ([value]) => {
        const baseline = c.baseline.encodeSync(value as never)
        const derived = c.derived.encodeSync(value as never)
        expect(derived).toStrictEqual(baseline)
      },
      { fastCheck: { numRuns: 200 } },
    )
  }
})
