# Product Distribution Requirements

This composite owns portable products and their independent import, refining
BUILD-R03. Its leaves own exact requirements:
[product contract](./01-product-contract/requirements.md) and
[Nix bridge](./02-nix-bridge/requirements.md).

## Assumptions

- **BUILD.DIST-A01 Separate authorities:** Production and import have independent
  expectations; activation and deployment remain consumer-owned.

## Acceptable Tradeoffs

- **BUILD.DIST-T01 Mechanism-specific import:** Distribution may use Nix
  substitution without making component identity Nix-specific.

## Requirements

- **BUILD.DIST-R01 Portable boundary (refines BUILD-R03):** A product crossing
  repositories has independently verified bytes, compatibility and provenance.
