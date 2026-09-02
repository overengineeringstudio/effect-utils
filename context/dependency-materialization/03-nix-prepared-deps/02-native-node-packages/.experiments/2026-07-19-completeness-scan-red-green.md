# Experiment — completeness scan RED/GREEN and lockfile-parser fix

Date: 2026-07-19 · System: x86_64-linux (portable)

## Question

Is the completeness assertion non-vacuous — does it go RED on a bindingless
prepared tree naming the missing families/triples and GREEN on a complete
tree — and does its detector actually reach the native families in a real
workspace lockfile?

## Method

- Detector + assertion over the resolved lockfile closure of a real vite ≈ 8.0.16
  workspace; harness cases: complete / bindingless / partial (one triple missing)
  / consumer-absent.
- Discrimination probe: drop exactly one binding
  (`@rolldown/binding-linux-arm64-gnu`) and confirm the failure names it.

## Result

- **Parser defect found and fixed.** The workspace `pnpm-lock.yaml` is a
  multi-document file (pnpm prepends a `---`-separated bootstrap document of
  ~20 snapshots). The initial scanner stopped at the first document boundary and
  never reached the real consumers, yielding a vacuous GREEN. Fix: keep scanning
  across documents.
  - Pre-fix: 20 consumers seen → vacuous pass.
  - Post-fix: 974 consumers seen → RED on the bindingless tree, reporting 40
    missing bindings across 6 families (bundler binding, CSS transformer, and
    `@tailwindcss/oxide`, `@esbuild`, `@oxc-parser`, `@oxc-resolver`).
- **RED/GREEN.** `--no-optional` tree → exit 1, naming the missing families and
  all declared triples. Opt-in tree → exit 0, printing the derived family set.
- **Discrimination.** Single-binding-drop probe → RED naming exactly
  `@rolldown/binding-linux-arm64-gnu`.
- **Regression fixtures.** New multi-document fixtures reproduce the vacuous-pass
  on the old parser, so the shipped bug stays caught.

## Conclusion

The assertion is non-vacuous and discriminating, and auto-derive reaches every
family in a real closure. Detecting a real multi-family gap that a hand-written
list would have under-counted is direct evidence for auto-derive.

## VRS Impact

Supports `DMP.NIX.NATIVE-R08` and `DMP.NIX.NATIVE-R10` (non-vacuous,
discriminating assertion) and `DMP.NIX.NATIVE-R09` with decision `0007`
(auto-derive reaches every family in a real closure).

## Residual

- GREEN used a reconstructed complete tree (the measured 58-`.node` FOD was
  GC'd); the RED on the real bindingless FOD is the authoritative half. The
  aarch64 end-to-end experiment supplies the real complete-tree evidence.
- A productionized in-repo check must bundle its policy import so it resolves
  standalone in the check derivation; a bare script would not resolve siblings.
