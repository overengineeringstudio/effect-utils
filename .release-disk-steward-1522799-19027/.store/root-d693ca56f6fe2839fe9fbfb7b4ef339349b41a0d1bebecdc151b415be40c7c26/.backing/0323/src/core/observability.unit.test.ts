/**
 * genie observability unit test.
 *
 * The per-namespace `observability.equivalence.unit.test.ts` migration bridge (a hand-authored
 * baseline mirroring pre-migration shape) was retired campaign-end — the derivation MECHANISM is
 * now proven once in `@overeng/otel-contract`'s `registry.unit.test.ts`. These are the two
 * NON-equivalence, absolute-behavior assertions that lived in genie's bridge and are worth keeping
 * here: that genie's REAL runtime `CommandOperation` derives a trimmed `span.label` and rejects a
 * non-finite numeric attribute on the trusted encode path.
 */
import { describe, expect, it } from 'vitest'

import type { OtelOperationDefinition } from '@overeng/otel-contract'

import { CommandOperation } from './genie.contract.ts'

describe('genie CommandOperation runtime span', () => {
  it('derives a trimmed span.label from the extractor', () => {
    const enc = (CommandOperation.operation as OtelOperationDefinition<never>).encodeSync({
      label: '  generate  ',
      cwd: '/repo',
    } as never)
    expect(enc['span.label']).toBe('generate')
  })

  it('rejects a non-finite numeric attribute (trusted-path parity)', () => {
    expect(() =>
      (CommandOperation.operation as OtelOperationDefinition<never>).encodeSync({
        label: 'gen',
        cwd: '/repo',
        concurrency: Number.POSITIVE_INFINITY,
      } as never),
    ).toThrow()
  })
})
