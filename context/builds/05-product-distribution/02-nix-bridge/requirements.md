# Nix Bridge Requirements

This subsystem owns the only shared Buck-to-system boundary: a portable
`BuildProduct` and independent Nix import. It refines BUILD.BUCK-R03 and BUILD.BUCK-R10.
(Formerly 04-artifact-system-bridge; content carried forward.)

## Assumptions

- **BUILD.DIST.NIX-A01 Buck product authority:** Buck produces normalized payload bytes
  and the descriptor that binds them.
- **BUILD.DIST.NIX-A02 Nix expectation authority:** The Nix consumer supplies the
  expected descriptor digest and target-platform constraints independently.

## Acceptable Tradeoffs

- **BUILD.DIST.NIX-T01 Narrow runtime admission:** Import may support fewer tagged
  runtime contracts than the descriptor vocabulary; unknown or uninspected
  runtime kinds fail closed.

## Requirements

### Must import independently

- **BUILD.DIST.NIX-R05 Independent expectation:** Import requires an expected
  descriptor digest and expected platform not obtained by trusting the payload.
- **BUILD.DIST.NIX-R06 Strict validation:** Import rejects unknown fields, missing
  fields, unsafe paths, unsupported runtime contracts, digest or size mismatch,
  platform mismatch, and unsafe archive contents.
- **BUILD.DIST.NIX-R07 Runtime inspection:** Import inspects the extracted runtime
  against the descriptor before producing a Nix store result.
- **BUILD.DIST.NIX-R08 Source fallback is the same graph:** A substitution miss rebuilds
  the product through the declared, sandboxed Buck graph at the pinned producer
  revision, fed only by independently verified per-digest archive inputs.
  Import never invokes an ad-hoc or unpinned build, and a rebuilt product must
  reproduce the pinned digest or fail (decisions 0037 and 0038).
- **BUILD.DIST.NIX-R09 Immutable result:** Successful import produces a read-only Nix
  store result containing only verified product content.
