# Native Cargo Workspace SSOT and Invalidation

## Status

Passed for native authoring composition and Buck closure locality on
2026-08-12. The workspace-aware Nix packaging bridge remains unproved.

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

| Control | Result |
| --- | --- |
| Virtual workspace with external exact members | Passed |
| Normalized dependency semantics before and after inheritance | Byte-equivalent |
| Independent `cargo check -p` for both packages | Passed |
| `cargo package` normalization of inherited fields | Passed |
| Warm metadata, workspace vs two standalone calls | 24 ms median vs 42 ms median |
| Add dependency reachable only from `otelite` | Root lock changed |
| `otel-scrape` reachable closure after that change | Stable at 33 nodes and identical digest |
| Member overrides root `default-features` policy | Cargo rejected it |
| Member-only source after workspace inheritance | Failed because workspace root was absent |

The shared-workspace prototype reduced selected identities from the descriptive
union of 257 current lock entries to 216, but this is not a causal cache result
because registry patch selections also advanced. At two crates, authored TOML
grew from 1,917 to 2,278 bytes due to fixed workspace overhead; its benefit is
semantic composition and future scaling rather than immediate line reduction.

## Conclusion

Native Cargo hierarchy is the authoring SSOT. The workspace root owns reusable
request and base policy; member manifests own package identity, use sites,
target predicates, optionality, and additive features. A small validator should
reject misleading inherited declarations and explicit bypasses, but no Genie
schema should generate Cargo manifests.

A lockfile owns selected topology only for its deliberate resolution domain.
Buck action identity is the normalized reachable operation/platform closure,
never whole-lock bytes. The current Nix derivations consume member-only sources
and package-local locks, so a shared domain may be selected only after a
workspace-aware, narrowly filtered Nix bridge proves unrelated-change locality.

## VRS Impact

Adds `BUCK.GRAPH.BIND.RUST-R10` and `BUCK.GRAPH.BIND.RUST-R11`, resolves
default-feature inheritance through decision 0002, and opens
`BUCK.GRAPH.BIND.RUST-DQ4` for the `otelite`/`otel-scrape` resolution domain.
