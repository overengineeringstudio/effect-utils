# Reusable Build Requirements

## Context

These contracts govern component identity, cache descriptors, authority, Buck
execution and product distribution. Consumer profiles select admitted products,
cache authorization and fleet integration; CI independently consumes build proof.

## Assumptions

- **BUILD-A01 Distinct authorities:** Build production, independent product import,
  cache authorization and live deployment have separate owners.

## Acceptable Tradeoffs

- **BUILD-T01 Consumer profiles:** Consumers may select different stamp and cache
  policies without redefining the shared schemas.

## Requirements

- **BUILD-R01 Component identity:** Component versions remain consistent across
  languages and modalities while source, action and deployment identities stay distinct.
- **BUILD-R02 Authority contraction:** Admission deletes superseded producers and
  records measurable cumulative complexity contraction in the authority ledger.
- **BUILD-R03 Portable products:** Independently verified products cross repository
  and build-mechanism boundaries without transferring deployment authority.
- **BUILD-R04 Composable reuse:** Cache descriptors compose without ambiguous
  protocol or identity; authorization never follows merely from a descriptor.
