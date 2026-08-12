# Buck2 Repository Build Open Questions

- [BUCK-DQ1](./spec.md#open-design-questions): which repository and package
  boundary own the shared contract and conformance tools after a second
  repository proves extraction. OCI transport and reviewed Nix pin authority
  are resolved by
  [decision 0008](./.decisions/0008-untrusted-oci-and-offline-nix-authority.md);
  they do not decide source ownership.

Subsystem specs own questions local to their mechanisms, including the
[Rust Cargo binding questions](./01-semantic-graph/01-authoring-bindings/02-rust-cargo/spec.md#open-design-questions).
Resolved questions leave this index and become normative spec text plus a
decision record when their tradeoff warrants one.
