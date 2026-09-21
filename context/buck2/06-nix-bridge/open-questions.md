# Nix Bridge Open Questions

## Open 2026-09-19: private pnpm consumption of Nix-realized tarballs

Decision 0037 routes private products to pnpm consumers as the Nix-realized tarball (`file:` in the staged manifest). The staged-manifest mechanism exists for workspace sources (mk-pnpm-cli), not for tarballs; unproven. Blocked on: a prototype in the private-shared product lane.

## Open 2026-09-19: Cachix retention and the R2 exit

Pins are GC-immune and revisioned; the publisher must name pins by digest and never re-point. Unknown: retention at our volume (92 historical releases; ~20 products) and the criteria that trigger the native S3/R2 binary cache. Blocked on: first month of cache-publisher operation.
