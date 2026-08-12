# Native Cargo Workspace SSOT and Invalidation

## Status

Passed for native authoring composition, Buck closure locality, and the
workspace-aware Nix packaging bridge on `x86_64-linux` on 2026-08-12.

## Question

Can a virtual Cargo workspace remove duplicate request authority without
making a shared lockfile the invalidation key for every Rust operation?

## Method

Disposable Cargo 1.95 workspaces reproduced the two committed Rust packages.
The controls moved common request policy and metadata to a virtual workspace,
kept member use sites and refinements local, compared normalized `cargo
metadata --no-deps --locked`, built each package independently, packaged one
member, and changed a dependency reachable only from the other member.

Separate adversarial fixtures tried member overrides that Cargo inheritance
cannot express and copied a member without its workspace root to reproduce the
current narrow Nix source shape.

## Result

| Control                                                      | Result                                   |
| ------------------------------------------------------------ | ---------------------------------------- |
| Virtual workspace with external exact members                | Passed                                   |
| Normalized dependency semantics before and after inheritance | Byte-equivalent                          |
| Independent `cargo check -p` for both packages               | Passed                                   |
| `cargo package` normalization of inherited fields            | Passed                                   |
| Warm metadata, workspace vs two standalone calls             | 24 ms median vs 42 ms median             |
| Add dependency reachable only from `otelite`                 | Root lock changed                        |
| `otel-scrape` reachable closure after that change            | Stable at 33 nodes and identical digest  |
| Member overrides root `default-features` policy              | Cargo rejected it                        |
| Member-only source after workspace inheritance               | Failed because workspace root was absent |

The shared-workspace prototype reduced selected identities from the descriptive
union of 257 current lock entries to 216, but this is not a causal cache result
because registry patch selections also advanced. At two crates, authored TOML
grew from 1,917 to 2,278 bytes due to fixed workspace overhead; its benefit is
semantic composition and future scaling rather than immediate line reduction.

## Implementation Verification

The repository implementation uses a virtual workspace at `rust/Cargo.toml`,
one `rust/Cargo.lock`, and one repository-root `rust-toolchain.toml`. Member
manifests link to the external workspace explicitly and inherit only the common
version, edition, license, `serde`, `serde_json`, and `tempfile` requests. The
two non-equivalent `libc` requests remain local and retain their exact request
and target-predicate semantics in `cargo metadata`.

| Control                                                            | Result                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Remove an external member's explicit workspace link                | RED: inherited fields fail with `failed to find a workspace root`       |
| Project an inherited member without `rust/Cargo.toml`              | RED: Cargo fails to read the declared workspace root                    |
| Compare normalized metadata and the two local `libc` exceptions    | GREEN: exact member set and request/predicate semantics preserved       |
| Inspect the realized Nix source for each member                    | GREEN: workspace contract present; sibling source and repo files absent |
| Run locked, offline metadata against each realized Nix source      | GREEN                                                                   |
| `nix build .#otel-scrape .#otelite --no-link -L` on `x86_64-linux` | GREEN: both packages and their full Nix test phases passed              |

The implementation deliberately keeps stock whole-lock Cargo vendoring. Both
package derivations therefore share the one vendor input, while their
first-party source derivations include only the selected package's Rust/test
tree plus the exact workspace manifest, lock, root toolchain, and two member
manifests. The Nix source helper reads `workspace.members` from the authored
Cargo manifest, so it does not maintain a parallel member inventory. No
projected lock or second dependency resolver was introduced.

## Conclusion

Native Cargo hierarchy is the authoring SSOT. The workspace root owns reusable
request and base policy; member manifests own package identity, use sites,
target predicates, optionality, and additive features. A small validator should
reject misleading inherited declarations and explicit bypasses, but no Genie
schema should generate Cargo manifests.

A lockfile owns selected topology only for its deliberate resolution domain.
Buck action identity is the normalized reachable operation/platform closure,
never whole-lock bytes. The Nix derivations now consume the shared workspace
contract and package-local first-party sources. Their stock vendor input is
coarse by design, without broadening either package's first-party source key.

## VRS Impact

Originally added `BUCK.GRAPH.BIND.RUST-R10` and
`BUCK.GRAPH.BIND.RUST-R11`, resolved default-feature inheritance through
decision 0002, and opened `BUCK.GRAPH.BIND.RUST-DQ4`. The implementation
evidence now closes the Nix-locality condition on decision 0003 for
`x86_64-linux`; other platforms remain separate admission cells.
