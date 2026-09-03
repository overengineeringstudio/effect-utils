# Experiment — aarch64 optional-binding closure end-to-end

Date: 2026-07-19 · Systems: aarch64-linux (build), x86_64-linux (cross-check)

## Question

For an install root that opts into optional native bindings under
`all-declared-triples` completeness, does the prepared FOD (a) contain every
declared `(os, cpu, libc)` binding, (b) load them at downstream build time, and
(c) stay host-invariant so a single shared hash remains sound?

## Method

- Real chain: a downstream aarch64-linux graph whose build loads native bundler
  and CSS-transformer bindings (rolldown ≈ 1.0.3, lightningcss ≈ 1.32.0) via
  vite ≈ 8.0.16, pnpm 11.
- Baseline: the default `--no-optional` prepared FOD.
- Treatment: the opt-in FOD with `supportedArchitectures` covering
  os[linux,darwin] × cpu[x64,arm64] × libc[glibc,musl].
- Realize the FOD on aarch64-linux; count `.node` files and binding dirs;
  `dlopen` the arm64-gnu bindings; run the downstream `vite build`; compare the
  realized output hash against x86_64-linux.

## Result

| Observation                               | `--no-optional`               | opt-in + completeness   |
| ----------------------------------------- | ----------------------------- | ----------------------- |
| `@rolldown/binding-*` dirs                | 0                             | present, all triples    |
| `.node` files in the prepared tree        | 0                             | 58                      |
| arm64-gnu bindings `dlopen`               | n/a                           | OK                      |
| downstream `vite build`                   | fails at runtime binding load | succeeds (2625 modules) |
| output hash aarch64-linux vs x86_64-linux | —                             | equal (host-invariant)  |

- Bindings resolved from each family's own isolated `.pnpm/<pkg>/node_modules/…`
  subtree; top-level `node_modules/<scope>` stayed empty — confirming the opt-in
  FOD, not a top-level graft, is the channel for `pure-package-artifact`
  families.

## Conclusion

On the measured linux pair, the opt-in prepared FOD carries every declared
binding (58 `.node` files across all declared triples), loads them at
downstream build time (`dlopen` OK; `vite build` succeeds), and is
host-invariant (equal realized output hash on aarch64-linux and x86_64-linux),
while the default `--no-optional` FOD fails the same downstream build at
runtime binding load.

## VRS Impact

Confirms `DMP.NIX.NATIVE-R08` (completeness), `DMP.NIX-R11` (the opt-in
resolves the runtime load), and the host-invariance premise behind `0008`/`0009`
and `DMP.NIX.FOD-R03` on the linux pair.

## Residual

- aarch64-darwin host-invariance is theory-only (verified on aarch64-linux and
  x86_64-linux); it remains a watch item until measured, and is representable via
  the `pending` FOD hash-evidence state (`DMP.NIX.FOD-R02`).
- The treatment ran a normalized prepared FOD; normalization (tar/relink,
  `.modules.yaml` strip) does not remove `.pnpm` package dirs, so presence
  detection holds.
