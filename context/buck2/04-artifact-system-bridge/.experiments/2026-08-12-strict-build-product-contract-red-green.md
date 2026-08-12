# Strict Build-Product Contract RED/GREEN

Date: 2026-08-12

## Question

Can the shared Buck-to-Nix product seam reject schema drift, keep invocation
evidence out of product identity, require an external descriptor identity, and
remain honest before any runtime inspector exists?

## Method

1. Add a focused pure-Nix contract test before its implementation exists.
2. Run the test from the exact foundation base `c31d61468` and preserve the
   expected failure.
3. Implement one exact validator/canonicalizer and route the importer through
   it.
4. Mutate the descriptor at the top level, semantic-provenance level, runtime
   tag, and external expected-digest boundary.
5. Exercise all four recognized runtime shapes as validation-only records.
6. Attempt an import of a synthetically packaged shell and require rejection
   because no runtime inspector exists.

## Result

The pre-implementation control failed because
`buck2-build-product-contract.nix` did not exist. This established that the new
test was not already passing through the permissive importer.

After implementation, the focused contract test passed and printed explicit
RED controls for:

- missing and wrong independently supplied descriptor digests;
- unknown top-level descriptor fields;
- evidence provenance embedded in the semantic descriptor;
- action identity embedded in semantic provenance; and
- an unknown runtime tag.

Independent review then broke two boundaries the initial proof had not fixed:
the descriptor accepted carriage-return or newline entrypoint bytes that the
archive scanner rejected, and GNU tar ignored bytes or another archive appended
after its first end marker. The hardened validator rejects both path bytes. The
scanner now reads through zero blocks and rejects appended non-padding bytes or
concatenated archives. A fixed canonical JSON byte vector and its fixed digest
replace the former self-comparison, while nested-field and semantic-identity
controls prevent schema and locality drift.

The four recognized runtime records (`interpreter`, `elf-dynamic`,
`mach-o-dynamic`, and `self-contained`) canonicalized successfully. This proves
only their exact schema. The bridge test then rejected the synthetic shell
archive with `runtime inspector is not available for self-contained`; it no
longer executes that shell as evidence of portable-product admission. Existing
archive safety controls remained green. The separate input-plan fixture was
relabeled `buck2-package-evidence`, so it no longer claims the strict product
kind while remaining explicitly provisional.

The canonical fixture descriptor digest was
`sha256:920dafd10e3eb7c3d54a0ef6d80213a58ceac533019537cb9e7098177b72389d`.

## Interpretation

The contract is now strict enough for language adapters to target one shared
shape without creating TypeScript or Rust importer branches. It deliberately
provides no successful product import. The next admission slice must implement
and independently break a real runtime inspector, beginning with the selected
static ELF Rust product.

## VRS Impact

The spec now records the implemented exact schema, canonical digest algorithm,
semantic/evidence provenance boundary, and validation-versus-admission
distinction. Requirements and vision remain unchanged.
