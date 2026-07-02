/**
 * Property-based encoder-equivalence proof for the `genie.*` telemetry migration (SC-R14).
 *
 * M3 re-points genie's runtime operations at DERIVED encoders from the registered seam contract
 * (`./genie.contract.ts`). This test proves "no runtime behavior lost": for every operation, the
 * DERIVED `OtelOperation` product surface (`.operation.encodeSync`) produces byte-identical
 * attribute maps to an INDEPENDENT, hand-authored baseline (inline `OtelAttr.*` +
 * `OtelOperation.define`, mirroring genie's pre-migration observability.ts) — over `Schema`
 * arbitraries that exercise the optional-present / optional-absent branches and `span.label`.
 *
 * The baseline is authored HERE, from `@overeng/otel-contract`'s runtime primitives directly (NOT
 * from the contract), so the comparison is real and not vacuous — the same discipline as M1's
 * `registry.unit.test.ts`.
 *
 * Coverage note: genie's catalog has NO enum, template, or counter/metric attributes, so those
 * branches (enum members, `template[...]`, trusted-vs-validated increment) are exercised by the
 * `acme` demo contract's `registry.unit.test.ts`, not here — genie has none to exercise.
 *
 * Arbitrary constraints (papercuts baked in): numeric attrs use `Schema.Int` (raw `Schema.Number`
 * would generate `NaN`/`±Infinity`, which the encoder rejects on BOTH sides → noise); labels use
 * `Schema.NonEmptyTrimmedString` (a whitespace-only `NonEmptyString` trims to empty → throws).
 */
import { it } from '@effect/vitest'
import { Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  OtelAttr,
  OtelAttrs,
  OtelOperation,
  type OtelOperationDefinition,
} from '@overeng/otel-contract'

import {
  AtomicWriteOperation,
  CommandOperation,
  FileOperation,
  ImportMapResolverOperation,
  OxfmtOperation,
  PathOperation,
  TargetLockOperation,
  ValidationOperation,
} from './genie.contract.ts'

// ---- generation-safe primitive schemas (arbitraries) ----
// `LabelGen` is TRIMMED so a whitespace-only value never trims to empty (→ throw); the actual
// label FIELD schema is plain `NonEmptyString`, matching genie's pre-migration observability.ts.
const LabelGen = Schema.NonEmptyTrimmedString
const Path = Schema.String
const Flag = Schema.Boolean
const Int = Schema.Int

// ---- independent hand-authored baselines (mirror pre-migration observability.ts EXACTLY) ----

const labelField = { label: Schema.NonEmptyString.pipe(OtelAttr.spanLabel()) }
const labelOf = ({ label }: { label: string }): string => label

const commandBaseline = OtelOperation.define({
  name: 'genie/command',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      ...labelField,
      cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
      readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
      dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
      concurrency: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.concurrency' }))),
    }),
  ),
  label: labelOf,
  root: true,
})

const fileBaseline = OtelOperation.define({
  name: 'genie/file',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      ...labelField,
      cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
      genieFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.source_path' })),
      targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
      readOnly: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.read_only' }))),
      dryRun: Schema.optional(Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.dry_run' }))),
    }),
  ),
  label: labelOf,
})

const pathBaseline = OtelOperation.define({
  name: 'genie/path',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({ ...labelField, path: Schema.String.pipe(OtelAttr.key({ key: 'genie.path' })) }),
  ),
  label: labelOf,
})

const oxfmtBaseline = OtelOperation.define({
  name: 'genie/oxfmt',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      ...labelField,
      targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
      hasConfig: Schema.Boolean.pipe(OtelAttr.key({ key: 'genie.oxfmt.has_config' })),
    }),
  ),
  label: labelOf,
})

const validationBaseline = OtelOperation.define({
  name: 'genie/runValidation',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      ...labelField,
      cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
      requirePackageJsonValidate: Schema.Boolean.pipe(
        OtelAttr.key({ key: 'genie.validation.require_package_json_validate' }),
      ),
      fileCount: Schema.optional(
        Schema.Number.pipe(OtelAttr.key({ key: 'genie.validation.file_count' })),
      ),
      preloadedFileCount: Schema.optional(
        Schema.Number.pipe(OtelAttr.key({ key: 'genie.validation.preloaded_file_count' })),
      ),
    }),
  ),
  label: labelOf,
})

const atomicWriteBaseline = OtelOperation.define({
  name: 'atomicWriteFile',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      ...labelField,
      targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
      mode: Schema.optional(Schema.Number.pipe(OtelAttr.key({ key: 'genie.file.mode' }))),
    }),
  ),
  label: labelOf,
})

const importMapResolverBaseline = OtelOperation.define({
  name: 'genie.registerImportMapResolver',
  attributes: OtelAttrs.defineSync(Schema.Struct({ ...labelField })),
  label: labelOf,
})

const targetLockBaseline = OtelOperation.define({
  name: 'genie/target-lock',
  attributes: OtelAttrs.defineSync(
    Schema.Struct({
      ...labelField,
      cwd: Schema.String.pipe(OtelAttr.key({ key: 'genie.cwd' })),
      targetFilePath: Schema.String.pipe(OtelAttr.key({ key: 'genie.file.target_path' })),
    }),
  ),
  label: labelOf,
})

// ---- per-operation input schemas driving the arbitraries ----
const cases = [
  {
    name: 'genie/command',
    baseline: commandBaseline,
    derived: CommandOperation.operation,
    input: Schema.Struct({
      label: LabelGen,
      cwd: Path,
      readOnly: Schema.optional(Flag),
      dryRun: Schema.optional(Flag),
      concurrency: Schema.optional(Int),
    }),
  },
  {
    name: 'genie/file',
    baseline: fileBaseline,
    derived: FileOperation.operation,
    input: Schema.Struct({
      label: LabelGen,
      cwd: Path,
      genieFilePath: Path,
      targetFilePath: Path,
      readOnly: Schema.optional(Flag),
      dryRun: Schema.optional(Flag),
    }),
  },
  {
    name: 'genie/path',
    baseline: pathBaseline,
    derived: PathOperation.operation,
    input: Schema.Struct({ label: LabelGen, path: Path }),
  },
  {
    name: 'genie/oxfmt',
    baseline: oxfmtBaseline,
    derived: OxfmtOperation.operation,
    input: Schema.Struct({ label: LabelGen, targetFilePath: Path, hasConfig: Flag }),
  },
  {
    name: 'genie/runValidation',
    baseline: validationBaseline,
    derived: ValidationOperation.operation,
    input: Schema.Struct({
      label: LabelGen,
      cwd: Path,
      requirePackageJsonValidate: Flag,
      fileCount: Schema.optional(Int),
      preloadedFileCount: Schema.optional(Int),
    }),
  },
  {
    name: 'atomicWriteFile',
    baseline: atomicWriteBaseline,
    derived: AtomicWriteOperation.operation,
    input: Schema.Struct({ label: LabelGen, targetFilePath: Path, mode: Schema.optional(Int) }),
  },
  {
    name: 'genie.registerImportMapResolver',
    baseline: importMapResolverBaseline,
    derived: ImportMapResolverOperation.operation,
    input: Schema.Struct({ label: LabelGen }),
  },
  {
    name: 'genie/target-lock',
    baseline: targetLockBaseline,
    derived: TargetLockOperation.operation,
    input: Schema.Struct({ label: LabelGen, cwd: Path, targetFilePath: Path }),
  },
] as const

describe('genie.* derived encoder ≡ hand-authored baseline (SC-R14, property-based)', () => {
  for (const c of cases) {
    it.prop(
      `${c.name}: derived .operation.encodeSync ≡ baseline.encodeSync over the optional/label branches`,
      [c.input],
      ([value]) => {
        const baseline = (c.baseline as OtelOperationDefinition<never>).encodeSync(value as never)
        const derived = (c.derived as OtelOperationDefinition<never>).encodeSync(value as never)
        // byte-identical attribute map (incl. `span.label`); ordering-insensitive.
        expect(derived).toStrictEqual(baseline)
        // the derived surface is a real product span with a resolved label.
        expect(typeof derived['span.label']).toBe('string')
      },
      { fastCheck: { numRuns: 200 } },
    )

    it(`${c.name}: derived and baseline agree on span name + attribute keys`, () => {
      expect(c.derived.metadata.name).toBe(c.baseline.metadata.name)
      expect([...c.derived.metadata.attributeKeys].toSorted()).toStrictEqual(
        [...c.baseline.metadata.attributeKeys].toSorted(),
      )
    })
  }

  it('span.label is trimmed identically on both surfaces (whitespace handling)', () => {
    const value = { label: '  generate  ', cwd: '/repo' } as never
    const baseline = (commandBaseline as OtelOperationDefinition<never>).encodeSync(value)
    const derived = (CommandOperation.operation as OtelOperationDefinition<never>).encodeSync(value)
    expect(derived).toStrictEqual(baseline)
    expect(derived['span.label']).toBe('generate')
  })

  it('a non-finite numeric attribute is rejected identically on both surfaces (trusted-path parity)', () => {
    const value = { label: 'gen', cwd: '/repo', concurrency: Number.POSITIVE_INFINITY } as never
    expect(() => (commandBaseline as OtelOperationDefinition<never>).encodeSync(value)).toThrow()
    expect(() =>
      (CommandOperation.operation as OtelOperationDefinition<never>).encodeSync(value),
    ).toThrow()
  })
})
