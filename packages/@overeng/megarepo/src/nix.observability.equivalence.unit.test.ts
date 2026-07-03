/**
 * Property-based encoder-equivalence proof for the `nix.*` telemetry migration (SC-R14).
 *
 * The migration re-points megarepo's runtime nix bridge bundles (`lib/observability.ts`) at the
 * DERIVED catalog schemas from the registered seam contract (`./nix.contract.ts`). This test proves
 * "no runtime behavior lost": each bundle rebuilt from the IMPORTED catalog schemas (exactly as
 * `observability.ts` does) produces byte-identical attribute maps to an INDEPENDENT, hand-authored
 * baseline (inline `OtelAttr.*` + `OtelAttrs.defineSync`), over `Schema` arbitraries.
 *
 * The baselines are authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the seam contract), so the comparison is real and not vacuous. `nix.lock.path` is the SAME
 * concept in two bundles (`nixLockFileAttrs` and `nixLockPathAttrs`); both reference the single
 * catalog attr `NixLockPath`, and both cases below prove it encodes to `nix.lock.path`.
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import { OtelAttr, OtelAttrs } from '@overeng/otel-contract'

import {
  NixFlakeOwner,
  NixFlakeRepo,
  NixFlakeRev,
  NixLockPath,
  NixLockSourcePath,
  NixLockSourceType,
  NixLockType,
} from './nix.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
const Str = Schema.NonEmptyTrimmedString

// ---- helpers to author independent baselines from otel-contract runtime primitives ----
const label = () => Schema.NonEmptyString.pipe(OtelAttr.spanLabel())
const s = (key: string) => Schema.String.pipe(OtelAttr.key({ key }))

// ---- independent hand-authored baselines (the nix bridge bundles) ----
const nixFlakeMetadataBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    owner: s('nix.flake.owner'),
    repo: s('nix.flake.repo'),
    rev: s('nix.flake.rev'),
  }),
)
const nixLockFileBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), path: s('nix.lock.path'), type: s('nix.lock.type') }),
)
const nixLockPathTypeBaseline = OtelAttrs.defineSync(
  Schema.Struct({
    label: label(),
    path: s('nix.lock.source_path'),
    type: s('nix.lock.source_type'),
  }),
)
const nixLockPathBaseline = OtelAttrs.defineSync(
  Schema.Struct({ label: label(), path: s('nix.lock.path') }),
)

const bundleCases = [
  {
    name: 'nixFlakeMetadataAttrs',
    baseline: nixFlakeMetadataBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({
        label: label(),
        owner: NixFlakeOwner,
        repo: NixFlakeRepo,
        rev: NixFlakeRev,
      }),
    ),
    input: Schema.Struct({ label: Str, owner: Str, repo: Str, rev: Str }),
  },
  {
    name: 'nixLockFileAttrs',
    baseline: nixLockFileBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ label: label(), path: NixLockPath, type: NixLockType }),
    ),
    input: Schema.Struct({ label: Str, path: Str, type: Str }),
  },
  {
    name: 'nixLockPathTypeAttrs',
    baseline: nixLockPathTypeBaseline,
    derived: OtelAttrs.defineSync(
      Schema.Struct({ label: label(), path: NixLockSourcePath, type: NixLockSourceType }),
    ),
    input: Schema.Struct({ label: Str, path: Str, type: Str }),
  },
  {
    name: 'nixLockPathAttrs',
    baseline: nixLockPathBaseline,
    derived: OtelAttrs.defineSync(Schema.Struct({ label: label(), path: NixLockPath })),
    input: Schema.Struct({ label: Str, path: Str }),
  },
] as const

describe('nix.* derived bridge encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of bundleCases) {
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

    it(`${c.name}: derived and baseline agree on attribute keys`, () => {
      expect([...c.derived.keys].toSorted()).toStrictEqual([...c.baseline.keys].toSorted())
    })
  }
})
