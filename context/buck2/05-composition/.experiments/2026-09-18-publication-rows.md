# Package Publication Rows

Date: 2026-09-18. Producer: effect-utils. Durable origin: immutable GitHub Release assets in `overengineeringstudio/effect-utils`. Producer commit: `9d58d20faa068e4fa10345d19db241abe48cdbec`.

## Question

Can the no-registry publication contract add the next dotfiles-facing package rows while keeping package runtime output, public integrity, and repeated publication deterministic?

## Method

1. Add package-product rows for `@overeng/utils-dev`, `@overeng/notion-core`, `@overeng/notion-effect-schema`, and `@overeng/notion-effect-client`.
2. Keep editor `dist` targets declaration-only. Add a separate TypeScript emit for package publication with runtime JavaScript enabled.
3. Build the package closure with a command-scoped `buck2.file_watcher=notify` override and local execution:

   ```console
   buck2 build -c buck2.file_watcher=notify --local-only --no-remote-cache //packages/@overeng/content-address:dist-package
   nix/buck2-products/publish.sh --proposal "$proposal"
   ```

4. Run the publisher a second time from the same clean producer commit and compare the two proposals byte-for-byte:

   ```console
   nix/buck2-products/publish.sh --proposal "$second_proposal"
   cmp "$proposal" "$second_proposal"
   ```

5. Fetch every package asset without authentication, require HTTP 200, compute SHA-512 over the fetched bytes, and compare it with `descriptor.sha512`.

## Result

The focused runtime package build succeeded. Publication produced these package assets:

| Package | SHA-256 | Bytes |
| --- | --- | ---: |
| `@overeng/content-address` | `7f63f9a6c9fbfdd27bc74646794150098444c78b4e4e18e82b337ef614a1e3db` | 18,072 |
| `@overeng/effect-distributed-lock` | `1fe85d5eeb3529af67fecda8ada4b4ce375da51a2a6bb1464374b1f9ee243296` | 7,697 |
| `@overeng/notion-core` | `e7c0f109bb868f0d0b2f502f23e535499c579631be12ecab78b5fbc136fb53ed` | 19,161 |
| `@overeng/notion-effect-client` | `33846387184e2db471f477e84cc48b27f8fdde2077e77108bb526606504e0b61` | 196,329 |
| `@overeng/notion-effect-schema` | `ecc65001ea3e346f335cc2ca950a2af74f5758f95a2730c990fd91d2cde46244` | 115,604 |
| `@overeng/otel-contract` | `ead4a8ae7f04b766ae6413f6e4afd56374f0357b0df64b547c9b55731c9caee0` | 89,278 |
| `@overeng/utils` | `5ec4fb7b529fb020ab4159491fe46ad8a36c9a8859370236f426eba925953f2b` | 289,672 |
| `@overeng/utils-dev` | `38731be366b561f5e72bb738a2ec816b0b818c2a0d98795229bb815c23294b7d` | 93,655 |

All eight public URLs returned HTTP 200. Every fetched SHA-512 matched the descriptor. The second publisher run reused every release, and its proposed manifest was byte-identical to the first proposal.

The four new package rows remain on Effect `3.20.0-rc.112`. Consumers on `3.20.0-rc.111` must align explicitly; publication does not rewrite or hide the peer mismatch.

## Conclusion

The next four package rows satisfy the immutable no-registry publication contract. A separate runtime emit is necessary because the editor `dist` became declaration-only after the original publication proof.

## VRS Impact

This experiment adds evidence for decision 0034. It does not amend requirements or accepted decisions.
