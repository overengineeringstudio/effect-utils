# Internals — Architecture

High-level map of the package for contributors: module boundaries
(`components/`, `renderer/`, `web/`, `cache/`), data flow from React tree
through reconciler to Notion mutations, and where each concern lives.
Projection of `../../context/vrs/spec.md` aimed at someone navigating the
source for the first time.

<!-- TODO: include an ASCII diagram of module boundaries + data flow -->
<!-- TODO: for each module, one-line role + pointer to its mod.ts -->
<!-- TODO: keep in sync with vrs/spec.md; flag divergences -->
