# 0007 Auto-Derive The Required Native Family Set

Status: accepted

## Context

A prepared artifact that opts into optional native bindings
(`DMP.NIX-R11`) must assert that every declared native family is present for
every declared platform triple (`DMP.NIX.NATIVE-R08`). The required-family set
could be a hand-maintained per-consumer list or derived from the resolved
closure.

## Evidence and Argument

- A hand list drifts silently. A closure commonly carries more than one native
  family (a bundler binding _and_ a CSS-transformer binding, for example); a
  list that names one and forgets the other passes review and fails the next
  build that loads the forgotten family.
- Over-approximation is in the safe direction. Presence-in-closure does not
  equal build-loaded, but pnpm optional install is per-root all-or-nothing, so
  materializing an unused-but-present family binding is free, while missing a
  loaded one is the failure this prevents.
- One registry, not two. The policy classification already distinguishes
  `pure-package-artifact` from `nix-grafted`; deriving from it avoids a second
  source of truth that could disagree.

## Options

| Option                                                     | Tradeoff                                                                                             | Outcome                    |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------- |
| Derive the required set from the resolved lockfile closure | Safe-direction over-approximation; reuses the existing native dependency policy as the one registry  | Accepted                   |
| Hand-maintained per-consumer `requiredNativeFamilies` list | Drifts silently; a list that forgets one family passes review and fails the next build that loads it | Rejected                   |
| Derived set plus an expected-set tripwire pin              | Catches an unreviewed family added by a dependency bump; auto-derive stays authoritative             | Admissible, off by default |

## Decision

Derive the required-family set from the root's resolved (dev + prod) lockfile
closure. Do not maintain a hand-written `requiredNativeFamilies` list.

The detector enumerates `pure-package-artifact` families in the closure (reusing
the native dependency policy, `0003`), expands each family's declared
`supportedArchitectures` into concrete `(os, cpu, libc)` triples, and treats the
product as the required set. Consumer input is limited to the opt-in plus
reason-carrying waivers (`DMP.NIX.NATIVE-R11`).

## Consequences

- Adding a native dependency automatically extends the required set on the next
  evaluation; no consumer edit is needed to keep the guarantee correct.
- A family with no prebuilt for a declared triple must be waived explicitly
  rather than omitted from the list.
- An optional expected-set tripwire (off by default) can pin the derived set so a
  dependency bump that adds a native family fails until reviewed; auto-derive
  stays authoritative.
